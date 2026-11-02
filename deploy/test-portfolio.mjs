import test from "node:test";
import assert from "node:assert/strict";
import { addVoiceRooms } from "./portfolio-project.mjs";
test("publishes only Andrey’s personal project and preserves all existing content", () => {
  const site = {
    revision: 7,
    team: [{ id: "andrey" }, { id: "darya" }],
    projects: [{ id: "arena", members: ["andrey", "darya"] }],
    home: { featuredIds: ["arena"] },
  };
  const { next, changed } = addVoiceRooms(site);
  assert.equal(changed, true);
  assert.deepEqual(next.projects[0], site.projects[0]);
  assert.deepEqual(next.team, site.team);
  assert.deepEqual(next.home, site.home);
  assert.equal(next.revision, 8);
  assert.deepEqual(next.projects[1].members, ["andrey"]);
  assert.equal(next.projects[1].scope, "personal");
  assert.equal(addVoiceRooms(next).changed, false);
  assert.equal(site.projects.length, 1);
});
test("refuses ambiguous ownership instead of overwriting another author", () => {
  assert.throws(() =>
    addVoiceRooms({
      team: [{ id: "andrey" }],
      projects: [{ id: "voicerooms", ownerId: "other" }],
    }),
  );
});
