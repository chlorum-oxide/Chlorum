// scripts/new-agent.mjs — mint a deployment identity offline
//
//   node scripts/new-agent.mjs
//
// Prints a fresh task id and the matching run lines. The console's
// Deploy view does the same thing for authenticated operators; this
// script exists for pre-staging without a running console.

import { mintTaskId, deploymentCommands } from "../server/hypochlorite/register.mjs";

const base = process.argv[2] || null;
const id = mintTaskId();
const cmds = deploymentCommands(id, base);

console.log("");
console.log("  ┌──────┐");
console.log("  │  Cl  │   new deployment identity");
console.log("  │ 35.45│");
console.log("  └──────┘");
console.log("");
console.log(`  task id  : ${cmds.taskId}`);
console.log(`  windows  : ${cmds.windows}`);
console.log(`  unix     : ${cmds.unix}`);
console.log("");
console.log("  the console accepts this id automatically on first contact.");
console.log("");
