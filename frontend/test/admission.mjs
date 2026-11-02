import test from "node:test";
import assert from "node:assert/strict";
globalThis.window = {};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
globalThis.location = { origin: "https://voise.24projects.ru" };
const { admissionProof, invite } = await import("../src/client.ts");
test("browser admission proof matches the cross-client protocol vector", async () => {
  assert.equal(
    await admissionProof("A".repeat(43)),
    "ae91ac6d8c0c08aeaddf908479e3a6fe4d9395bb0343e4fd13a6ab6c7d0aa9a9",
  );
});
test("invitation keeps the encryption key in the fragment, with no media JWT", () => {
  const url = new URL(invite("ABCDEFGH", "A".repeat(43)));
  assert.equal(url.searchParams.get("room"), "ABCDEFGH");
  assert.equal(url.searchParams.has("key"), false);
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.hash, "#key=" + "A".repeat(43));
});
