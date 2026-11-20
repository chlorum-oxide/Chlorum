// chloride/codec.mjs — the reagent wire codec
//
// All node <-> console traffic moves as "reagents": a sealed envelope
// carrying a command name and its payload. Nothing on the wire is
// plain JSON, so passive observers see opaque binary with random
// length, not readable task structures.
//
// encoding chain:  compact JSON -> zlib deflate -> AES-256-CBC
// envelope layout: "REAG" | salt(8) | iv(16) | ciphertext
//
// profileKey is a 64-hex-char string derived on both ends from the
// deployment identity; it never travels on the wire.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const REAGENT_MAGIC = "REAG";
const HEADER_LEN = 4 + 8 + 16;

function deriveKey(profileKey, salt) {
  return createHash("sha256").update(`${profileKey}:${salt.toString("hex")}`).digest();
}

export function newReagent(r, m = {}) {
  return { r, m };
}

export function packReagent(reagent, profileKey) {
  if (typeof reagent?.r !== "string" || !reagent.r) {
    throw new Error("reagent requires a command name");
  }
  const salt = randomBytes(8);
  const iv = randomBytes(16);
  const key = deriveKey(profileKey, salt);
  const plain = deflateSync(Buffer.from(JSON.stringify(reagent), "utf8"));
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([
    Buffer.from(REAGENT_MAGIC, "utf8"),
    salt,
    iv,
    body,
  ]);
}

export function unpackReagent(buf, profileKey) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN + 16) {
    throw new Error("reagent envelope too short");
  }
  if (buf.subarray(0, 4).toString("utf8") !== REAGENT_MAGIC) {
    throw new Error("not a reagent envelope");
  }
  const salt = buf.subarray(4, 12);
  const iv = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const key = deriveKey(profileKey, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(inflateSync(plain).toString("utf8"));
}
