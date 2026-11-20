// server/gofile.mjs — disposable archive relay
//
// Guest uploads against the public gofile API. Verified live during
// the cl-35 build:
//   GET  https://api.gofile.io/servers           -> { status:"ok", data:{ servers:[{name,zone},...] } }
//   POST https://<server>.gofile.io/uploadFile   -> { status:"ok", data:{ code, downloadPage, guestToken, ... } }
//
// No account, no token needed for guest uploads. The returned
// downloadPage is the operator-facing link; guestToken is kept only
// in the state file in case a deletion call is ever needed.

const SERVERS_URL = "https://api.gofile.io/servers";

let cachedServer = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function pickServer() {
  const now = Date.now();
  if (cachedServer && now - cachedAt < CACHE_TTL) return cachedServer;
  const res = await fetch(SERVERS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`gofile servers ${res.status}`);
  const json = await res.json();
  const name = json?.data?.servers?.[0]?.name;
  if (!name) throw new Error("gofile returned no store");
  cachedServer = name;
  cachedAt = now;
  return name;
}

export async function uploadToGofile(buffer, filename) {
  const server = await pickServer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: "application/octet-stream" }),
    `${filename}.bin`
  );
  const res = await fetch(`https://${server}.gofile.io/uploadFile`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`gofile upload ${res.status}`);
  const json = await res.json();
  if (json?.status !== "ok" || !json?.data?.downloadPage) {
    throw new Error("gofile upload rejected");
  }
  return json.data;
}
