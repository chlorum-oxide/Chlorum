// agents/tasks/kill.mjs — disarm and exit
//
// Removes persistence (perchlorate) and reports. The runtime loop
// sees the result, wipes the local vault dir flag and exits 0.

import { rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { perchlorate } from "../perchlorate.mjs";

export async function kill({ taskId }) {
  const removed = perchlorate.clear();
  try {
    rmSync(join(os.homedir(), ".chlorum"), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return { summary: `kill acknowledged for ${taskId}`, removed };
}
