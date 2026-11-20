// server/index.mjs — chlorum console entry
//
//   node server/index.mjs
//
// Boots the console on CHLORUM_PORT (default 8787). The first
// operator signup through the UI becomes the admin and owns the
// deployment.

import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { State } from "./state.mjs";
import { createRouter } from "./routes.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const config = loadConfig({ cwd: resolve(__dirname, "..") });
const state = new State(join(config.dataDir, "chlorum.json"));
const router = createRouter({
  config,
  state,
  uiDir: join(__dirname, "..", "ui"),
});

const server = http.createServer((req, res) => router.handle(req, res));

server.listen(config.port, () => {
  console.log("");
  console.log("  ┌──────┐");
  console.log("  │  Cl  │   chlorum console — cl-35");
  console.log("  │ 35.45│   phosphor online");
  console.log("  └──────┘");
  console.log("");
  console.log(`  listening : http://127.0.0.1:${config.port}`);
  console.log(`  data dir  : ${config.dataDir}`);
  console.log(`  gofile    : ${config.gofileRelay ? "on" : "off"}`);
  console.log(`  operators : ${state.hasOperators() ? "provisioned" : "none yet — first signup becomes admin"}`);
  console.log("");
});
