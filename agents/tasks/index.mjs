// agents/tasks/index.mjs — task handler registry

import { probe } from "./probe.mjs";
import { scan } from "./scan.mjs";
import { shell } from "./shell.mjs";
import { kill } from "./kill.mjs";
import { collect } from "./collect.mjs";

export function loadTaskHandlers() {
  return { probe, scan, shell, kill, collect };
}
