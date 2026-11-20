// agents/tasks/shell.mjs — command execution with capture
//
// args: { cmd, timeout? }  — timeout capped at 60s by the console,
// captured output capped at 256 KB by the node.

import { exec } from "node:child_process";

const OUTPUT_CAP = 256 * 1024;

export async function shell({ args }) {
  const cmd = args.cmd;
  const timeout = Math.min(args.timeout || 30_000, 60_000);

  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true, maxBuffer: OUTPUT_CAP }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) {
        resolve({ ok: false, error: err.message.slice(0, 500) });
        return;
      }
      resolve({
        summary: `shell: ${cmd.slice(0, 80)}`,
        code: err?.code ?? 0,
        stdout: String(stdout).slice(0, OUTPUT_CAP),
        stderr: String(stderr).slice(0, 8192),
      });
    });
  });
}
