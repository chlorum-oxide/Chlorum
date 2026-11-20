// agents/tasks/probe.mjs — refresh the node profile

import os from "node:os";

export async function probe() {
  return {
    summary: "probe",
    profile: {
      os: os.platform(),
      osVersion: os.release(),
      arch: os.arch(),
      host: os.hostname(),
      user: os.userInfo().username,
      uptime: Math.floor(os.uptime()),
      cpus: os.cpus().length,
      memTotal: os.totalmem(),
      cwd: process.cwd(),
      runtime: `node ${process.version}`,
    },
  };
}
