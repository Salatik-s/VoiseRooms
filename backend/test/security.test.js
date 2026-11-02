import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  issueSession,
  readSession,
  participantId,
  isActive,
} from "../src/security.js";
import { verifyInitData } from "../src/telegram-auth.js";
const secret = "test-only-secret-".repeat(4);
test("signed guest sessions cannot be forged, expire and do not expose cross-room identity", () => {
  const token = issueSession(-22, secret, false, 1000);
  assert.equal(readSession(token, secret, 1001).id, -22);
  assert.equal(readSession(token + "x", secret, 1001), null);
  assert.equal(readSession(token, "wrong", 1001), null);
  assert.equal(readSession(token, secret, 1e12), null);
  assert.notEqual(
    participantId("one", 22, secret),
    participantId("two", 22, secret),
  );
});
test("expired private rooms cannot accept participants", () => {
  assert.equal(
    isActive({ isActive: true, expiresAt: new Date(100) }, 200),
    false,
  );
  assert.equal(isActive({ isActive: false, isPersistent: true }), false);
});
test("Telegram authentication requires fresh, unique and correctly signed parameters", () => {
  const token = "123456:example",
    params = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42, first_name: "Test" }),
    });
  const data = [...params]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => k + "=" + v)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", key).update(data).digest("hex"));
  assert.equal(verifyInitData(params.toString(), token).id, 42);
  assert.equal(verifyInitData(params.toString() + "&auth_date=1", token), null);
  params.set("auth_date", "1");
  assert.equal(verifyInitData(params.toString(), token), null);
});
