// chloride/vault.mjs — sealed local storage
//
// Files dropped by a node are sealed on disk with ChaCha20-Poly1305
// before anything else happens to them. The console can re-open them
// because it derives the same key from the deployment identity, but
// the key itself is never written anywhere.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAGIC = "CHLV1";
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;

function stretchKey(keyBuf, salt) {
  return scryptSync(keyBuf, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function seal(keyBuf, plaintext) {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const stretched = stretchKey(keyBuf, salt);
  const cipher = createCipheriv("chacha20-poly1305", stretched, nonce, {
    authTagLength: TAG_LEN,
  });
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC, "utf8"),
    salt,
    nonce,
    tag,
    sealed,
  ]);
}

export function open(envelope, keyBuf) {
  if (!Buffer.isBuffer(envelope) || envelope.length < 5 + SALT_LEN + NONCE_LEN + TAG_LEN) {
    throw new Error("vault envelope too short");
  }
  if (envelope.subarray(0, 5).toString("utf8") !== MAGIC) {
    throw new Error("not a vault envelope");
  }
  let off = 5;
  const salt = envelope.subarray(off, off + SALT_LEN); off += SALT_LEN;
  const nonce = envelope.subarray(off, off + NONCE_LEN); off += NONCE_LEN;
  const tag = envelope.subarray(off, off + TAG_LEN); off += TAG_LEN;
  const sealed = envelope.subarray(off);
  const stretched = stretchKey(keyBuf, salt);
  const decipher = createDecipheriv("chacha20-poly1305", stretched, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed), decipher.final()]);
}

export function saveVaultFile(dir, name, keyBuf, data) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seal(keyBuf, data));
}

export function loadVaultFile(dir, name, keyBuf) {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`vault file missing: ${name}`);
  return open(readFileSync(path), keyBuf);
}
