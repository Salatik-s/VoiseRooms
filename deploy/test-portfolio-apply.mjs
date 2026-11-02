import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { addVoiceRooms } from "./portfolio-project.mjs";
import { applyPortfolio } from "./portfolio-apply.mjs";
async function cleanup(root) {
  const safe = resolve(root);
  if (
    dirname(safe) !== resolve(tmpdir()) ||
    !basename(safe).startsWith("voice-portfolio-")
  )
    throw Error("Unsafe test cleanup path");
  await rm(safe, { recursive: true, force: true });
}
test("backs up exact original bytes and applies once", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-portfolio-"));
  try {
    const original =
      JSON.stringify({
        team: [{ id: "andrey" }],
        projects: [{ id: "untouched" }],
        revision: 4,
      }) + "\n";
    await writeFile(join(root, "site.json"), original);
    const result = await applyPortfolio(root, {
      validate: (s) => assert.ok(Array.isArray(s.projects)),
      transform: addVoiceRooms,
    });
    assert.equal(await readFile(result.backup, "utf8"), original);
    const next = JSON.parse(await readFile(join(root, "site.json"), "utf8"));
    assert.equal(next.projects.length, 2);
    assert.equal(next.projects[0].id, "untouched");
    assert.equal(
      (
        await applyPortfolio(root, {
          validate: () => {},
          transform: addVoiceRooms,
        })
      ).changed,
      false,
    );
  } finally {
    await cleanup(root);
  }
});
test("validation failure leaves original data byte-for-byte intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-portfolio-"));
  try {
    const original = JSON.stringify({ team: [{ id: "andrey" }], projects: [] });
    await writeFile(join(root, "site.json"), original);
    await assert.rejects(
      applyPortfolio(root, {
        validate: (s) => {
          if (s.projects.length) throw Error("reject candidate");
        },
        transform: addVoiceRooms,
      }),
    );
    assert.equal(await readFile(join(root, "site.json"), "utf8"), original);
  } finally {
    await cleanup(root);
  }
});
