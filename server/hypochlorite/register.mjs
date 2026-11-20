// server/hypochlorite/register.mjs — node identity handling
//
// The deployment identity (task id) is minted by the console and
// derived into a profile key on both ends. The console never stores
// the profile key; it recomputes it on demand. Losing the master
// token therefore bricks every outstanding identity at once, which
// is the intended failure mode.

import { createHash, randomBytes } from "node:crypto";

// The node derives its wire key from its deployment identity alone;
// the console derives the identical value. The master token never
// reaches the node and never protects node traffic — the identity
// string IS the credential (see docs/identity.md).
export function deriveProfileKey(taskId) {
  return createHash("sha256").update(`chlorum-node-key:${taskId}`).digest("hex");
}

export function deriveVaultKey(taskId, adminToken) {
  return Buffer.from(`${taskId}:${adminToken}`, "utf8");
}

export function validTaskId(id) {
  return typeof id === "string" && /^cl-[a-z0-9-]{2,32}$/.test(id);
}

export function mintTaskId() {
  const words = [
    "argon", "neon", "xenon", "krypton", "radon",
    "fluorine", "bromine", "iodine", "astatine", "oganesson",
  ];
  const word = words[Math.floor(Math.random() * words.length)];
  return `cl-${word}-${randomBytes(2).toString("hex")}`;
}

const MAX_STR = 200;

function clip(value) {
  if (typeof value !== "string") return undefined;
  return value.slice(0, MAX_STR);
}

export function normalizeProfile(raw = {}) {
  const p = {
    os: clip(raw.os) || "unknown",
    osVersion: clip(raw.osVersion) || "unknown",
    arch: clip(raw.arch) || "unknown",
    host: clip(raw.host) || "unknown",
    user: clip(raw.user) || "unknown",
    cwd: clip(raw.cwd) || "",
    runtime: clip(raw.runtime) || "",
    bootAt: clip(raw.bootAt) || "",
  };
  // the probe task reports numeric facts beyond the string identity;
  // keep them when they are present and well-formed
  if (Number.isFinite(raw.uptime)) p.uptime = raw.uptime;
  if (Number.isFinite(raw.cpus)) p.cpus = raw.cpus;
  if (Number.isFinite(raw.memTotal)) p.memTotal = raw.memTotal;
  return p;
}

export function deploymentCommands(taskId, base) {
  const b = base || "http://<console-host>:8787";
  return {
    taskId,
    windows: `node agents\\agent.mjs ${taskId} ${b}`,
    unix: `node agents/agent.mjs ${taskId} ${b}`,
  };
}
