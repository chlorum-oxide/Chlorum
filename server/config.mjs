// server/config.mjs — environment handling
//
// A minimal .env reader (zero dependencies) plus strict validation of
// the CHLORUM_* namespace. The console refuses to boot without a
// master token; everything else has safe defaults.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export function loadConfig({ cwd = process.cwd() } = {}) {
  const adminToken = process.env.CHLORUM_ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 16) {
    console.error(
      "[chlorum] CHLORUM_ADMIN_TOKEN is missing or too short (>= 16 chars).\n" +
        "[chlorum] copy .env.example to .env, set the token, then start again."
    );
    process.exit(1);
  }

  return {
    port: Number(process.env.CHLORUM_PORT || 8787),
    adminToken,
    secret: process.env.CHLORUM_SECRET || null, // state layer generates one if null
    dataDir: resolve(cwd, process.env.CHLORUM_DATA_DIR || "./data"),
    gofileRelay: (process.env.CHLORUM_GOFILE ?? "1") !== "0",
    vaultDir: resolve(cwd, process.env.CHLORUM_DATA_DIR || "./data", "vault"),
  };
}
