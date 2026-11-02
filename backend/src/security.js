import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  randomInt,
} from "node:crypto";
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issueSession(id, secret, admin = false, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({ id, admin, exp: now + (admin ? 86400000 : 2592000000) }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
export function readSession(token, secret, now = Date.now()) {
  try {
    const [b, s, ...extra] = String(token || "").split(".");
    if (
      extra.length ||
      !sameSecret(s, createHmac("sha256", secret).update(b).digest("base64url"))
    )
      return null;
    const data = JSON.parse(Buffer.from(b, "base64url"));
    if (
      !Number.isSafeInteger(data.id) ||
      !data.id ||
      !Number.isFinite(data.exp) ||
      data.exp <= now ||
      data.exp > now + 2592000000 + 60000
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
export function guestId() {
  return -randomInt(1, 2 ** 47);
}
export function participantId(room, id, secret) {
  return createHmac("sha256", secret)
    .update(room + ":" + id)
    .digest("hex")
    .slice(0, 24);
}
export function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(8), (x) => chars[x % chars.length]).join("");
}
export function isActive(room, now = Date.now()) {
  return (
    !!room?.isActive &&
    (room.isPersistent ||
      !room.expiresAt ||
      new Date(room.expiresAt).getTime() > now)
  );
}
