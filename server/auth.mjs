// server/auth.mjs — operator accounts and sessions
//
// scrypt-hashed passwords, opaque session cookies, HttpOnly +
// SameSite=Strict. The very first signup becomes the admin and
// "holds the keys" for the deployment; later signups are operators.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_OPTS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function strongEnough(password) {
  return typeof password === "string" && password.length >= 10;
}

export function signup(state, { email, password }) {
  if (!validEmail(email)) throw new Error("email looks wrong");
  if (!strongEnough(password)) throw new Error("password needs >= 10 chars");
  if (state.findOperator(email)) throw new Error("operator exists");
  const role = state.hasOperators() ? "operator" : "admin";
  const op = {
    email,
    phash: hashPassword(password),
    role,
    created: new Date().toISOString(),
  };
  state.addOperator(op);
  return op;
}

export function login(state, { email, password }) {
  const op = state.findOperator(email);
  if (!op || !verifyPassword(password, op.phash)) return null;
  const sid = randomBytes(24).toString("hex");
  state.putSession(sid, email);
  return { sid, op };
}

export function sessionCookie(sid, secure) {
  const flags = [
    `chl_sid=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${7 * 24 * 3600}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function operatorFromRequest(state, req) {
  const sid = parseCookies(req).chl_sid;
  if (!sid) return null;
  const session = state.getSession(sid);
  if (!session) return null;
  return state.findOperator(session.email);
}
