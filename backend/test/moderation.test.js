import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessToken, TokenVerifier, TrackSource } from "livekit-server-sdk";
import { buildApp } from "../src/index.js";
import { issueSession, participantId } from "../src/security.js";
async function fixture(t) {
  const secret = "test-management-secret-".repeat(4),
    env = {
      INTERNAL_KEY: secret,
      OWNER_TG_ID: "900",
      LIVEKIT_API_KEY: "testkey",
      LIVEKIT_API_SECRET: "test-media-secret-".repeat(4),
      DOMAIN: "localhost",
      PERSISTENT_ROOMS: "|",
      UPLOADS_DIR: await mkdtemp(join(tmpdir(), "vr-moderation-")),
    };
  const room = {
      id: 1,
      code: "TESTROOM",
      name: "Test",
      ownerTgId: -1n,
      isActive: true,
      isPersistent: false,
      encrypted: false,
      isLocked: false,
      maxParticipants: 8,
    },
    rooms = [room, { ...room, id: 2, code: "OTHERROOM", ownerTgId: -4n }],
    members = [],
    bans = [],
    live = new Map(),
    removed = [],
    mutes = [];
  const identity = (id, code = "TESTROOM") => participantId(code, id, secret);
  for (const id of [-1, -2, -3, 900])
    members.push({
      roomId: 1,
      identity: identity(id),
      displayName: "Member " + id,
      microphoneBlocked: false,
      allowedWhileLocked: false,
    });
  members.push({
    roomId: 2,
    identity: identity(-4, "OTHERROOM"),
    displayName: "Other",
  });
  const match = (o, w = {}) =>
    Object.entries(w).every(([k, v]) =>
      v && typeof v === "object"
        ? v.in
          ? v.in.includes(o[k])
          : true
        : o[k] === v,
    );
  const find = (a, w) => a.find((x) => match(x, w));
  const db = {
    $connect: async () => {},
    $disconnect: async () => {},
    $transaction: async (f) => f(db),
    user: { upsert: async () => ({}) },
    room: {
      findUnique: async ({ where }) => find(rooms, where),
      findMany: async ({ where }) => rooms.filter((r) => match(r, where)),
      count: async () => 0,
      create: async ({ data }) => {
        const r = {
          ...data,
          id: rooms.length + 1,
          isActive: true,
          isLocked: false,
        };
        rooms.push(r);
        return r;
      },
      update: async ({ where, data }) =>
        Object.assign(find(rooms, where), data),
    },
    roomParticipantName: {
      findUnique: async ({ where: { roomId_identity: w } }) => find(members, w),
      findMany: async ({ where }) => members.filter((m) => match(m, where)),
      upsert: async ({ where: { roomId_identity: w }, create, update }) => {
        let m = find(members, w);
        if (m) Object.assign(m, update);
        else {
          m = {
            microphoneBlocked: false,
            allowedWhileLocked: false,
            ...create,
          };
          members.push(m);
        }
        return m;
      },
      update: async ({ where: { roomId_identity: w }, data }) =>
        Object.assign(find(members, w), data),
      updateMany: async ({ where, data }) => {
        for (const m of members) if (match(m, where)) Object.assign(m, data);
      },
    },
    roomBan: {
      findUnique: async ({ where: { roomId_identity: w } }) => find(bans, w),
      findMany: async ({ where }) => bans.filter((b) => match(b, where)),
      upsert: async ({ create }) => {
        if (!find(bans, create)) bans.push(create);
        return create;
      },
      deleteMany: async ({ where }) => {
        for (let i = bans.length - 1; i >= 0; i--)
          if (match(bans[i], where)) bans.splice(i, 1);
      },
    },
  };
  const media = {
    createRoom: async () => ({}),
    deleteRoom: async (code) => {
      for (const [id, p] of live) if (p.room === code) live.delete(id);
    },
    listParticipants: async (code) =>
      [...live.values()].filter((p) => p.room === code),
    removeParticipant: async (code, id) => {
      removed.push(id);
      live.delete(id);
    },
    getParticipant: async (code, id) => {
      const p = live.get(id);
      if (!p || p.room !== code)
        throw Object.assign(Error("missing"), { status: 404 });
      return p;
    },
    updateParticipant: async (code, id, data) =>
      Object.assign(live.get(id), data),
    mutePublishedTrack: async (code, id, sid, muted) => mutes.push(muted),
  };
  const app = await buildApp({ env, prisma: db, media });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(env.UPLOADS_DIR, { recursive: true, force: true });
  });
  const req = async (method, url, id = -1, payload) => {
    const r = await app.inject({
      method,
      url,
      headers: {
        authorization: "Bearer " + issueSession(id, secret, id === 900),
      },
      payload,
    });
    return { status: r.statusCode, ...r.json() };
  };
  const connect = (id) => {
    live.set(identity(id), {
      identity: identity(id),
      name: "Member " + id,
      room: "TESTROOM",
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
      },
      tracks: [{ sid: "mic", source: TrackSource.MICROPHONE }],
    });
  };
  const webhook = async (id) => {
    const body = JSON.stringify({
        event: "participant_joined",
        room: { name: "TESTROOM" },
        participant: { identity: identity(id) },
      }),
      at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    return app.inject({
      method: "POST",
      url: "/api/livekit/webhook",
      headers: {
        "content-type": "application/webhook+json",
        authorization: await at.toJwt(),
      },
      payload: body,
    });
  };
  const claims = (token) =>
    new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).verify(
      token,
    );
  return {
    app,
    req,
    identity,
    connect,
    webhook,
    claims,
    room,
    live,
    bans,
    mutes,
  };
}
test("creator rights are assigned server-side and scoped to one room", async (t) => {
  const f = await fixture(t),
    r = await f.req("POST", "/api/room/create", -2, { encrypted: false });
  assert.equal(r.isOwner, true);
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: r.code })).isAdmin,
    true,
  );
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: r.code, isAdmin: true }))
      .isAdmin,
    false,
  );
  for (const action of ["mute", "kick", "ban", "unban", "lock", "close"])
    assert.equal(
      (
        await f.req("POST", "/api/room/TESTROOM/" + action, -2, {
          targetIdentity: f.identity(-3),
          muted: true,
          locked: true,
        })
      ).status,
      403,
    );
  assert.equal(
    (await f.req("GET", "/api/room/TESTROOM/moderation", -2)).status,
    403,
  );
  assert.equal(
    (await f.req("POST", "/api/room/OTHERROOM/lock", -1, { locked: true }))
      .status,
    403,
  );
});
test("kick allows re-entry; ban applies only to its room until removed", async (t) => {
  const f = await fixture(t);
  f.connect(-2);
  assert.equal(
    (
      await f.req("POST", "/api/room/TESTROOM/kick", -1, {
        targetIdentity: f.identity(-2),
      })
    ).status,
    200,
  );
  assert.equal(f.bans.length, 0);
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    200,
  );
  assert.equal(
    (
      await f.req("POST", "/api/room/TESTROOM/ban", -1, {
        targetIdentity: f.identity(-2),
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    403,
  );
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "OTHERROOM" })).status,
    200,
  );
  assert.equal(
    (await f.req("GET", "/api/room/TESTROOM/moderation")).bans[0].identity,
    f.identity(-2),
  );
  await f.req("POST", "/api/room/TESTROOM/unban", -1, {
    targetIdentity: f.identity(-2),
  });
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    200,
  );
});
test("lock keeps current participants and rejects new arrivals including cached tokens", async (t) => {
  const f = await fixture(t);
  f.connect(-1);
  f.connect(-2);
  await f.req("POST", "/api/token", -3, { room: "TESTROOM" });
  assert.equal(
    (await f.req("POST", "/api/room/TESTROOM/lock", -1, { locked: true }))
      .status,
    200,
  );
  for (const id of [-1, -2])
    assert.equal(
      (await f.req("POST", "/api/token", id, { room: "TESTROOM" })).status,
      200,
    );
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: "TESTROOM" })).status,
    403,
  );
  f.connect(-3);
  assert.equal((await f.webhook(-3)).statusCode, 200);
  assert.equal(f.live.has(f.identity(-3)), false);
  await f.req("POST", "/api/room/TESTROOM/kick", -1, {
    targetIdentity: f.identity(-2),
  });
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    403,
  );
  await f.req("POST", "/api/room/TESTROOM/lock", -1, { locked: false });
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: "TESTROOM" })).status,
    200,
  );
});
test("microphone restriction survives reconnect and unmute never activates a microphone", async (t) => {
  const f = await fixture(t);
  f.connect(-2);
  assert.equal(
    (
      await f.req("POST", "/api/room/TESTROOM/mute", -1, {
        targetIdentity: f.identity(-2),
        muted: true,
      })
    ).status,
    200,
  );
  let r = await f.req("POST", "/api/token", -2, { room: "TESTROOM" }),
    c = await f.claims(r.token);
  assert.equal(c.video.canPublishSources.includes("microphone"), false);
  assert.equal(c.video.canPublishSources.includes("screen_share"), true);
  f.connect(-2);
  assert.equal((await f.webhook(-2)).statusCode, 200);
  assert.equal(
    f.live
      .get(f.identity(-2))
      .permission.canPublishSources.includes(TrackSource.MICROPHONE),
    false,
  );
  await f.req("POST", "/api/room/TESTROOM/mute", -1, {
    targetIdentity: f.identity(-2),
    muted: false,
  });
  assert.ok(f.mutes.length);
  assert.ok(f.mutes.every(Boolean));
  r = await f.req("POST", "/api/token", -2, { room: "TESTROOM" });
  c = await f.claims(r.token);
  assert.equal(c.video.canPublishSources.includes("microphone"), true);
});
test("protect managers and foreign identities; bans and closure invalidate cached admissions", async (t) => {
  const f = await fixture(t);
  for (const id of [-1, 900])
    assert.equal(
      (
        await f.req("POST", "/api/room/TESTROOM/ban", -1, {
          targetIdentity: f.identity(id),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.req("POST", "/api/room/TESTROOM/ban", -1, {
        targetIdentity: f.identity(-4, "OTHERROOM"),
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.req("POST", "/api/room/TESTROOM/lock", -1, { locked: "true" }))
      .status,
    400,
  );
  await f.req("POST", "/api/room/TESTROOM/ban", -1, {
    targetIdentity: f.identity(-2),
  });
  f.connect(-2);
  assert.equal((await f.webhook(-2)).statusCode, 200);
  assert.equal(f.live.has(f.identity(-2)), false);
  assert.equal((await f.req("POST", "/api/room/TESTROOM/close")).status, 200);
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: "TESTROOM" })).status,
    410,
  );
  f.connect(-3);
  assert.equal((await f.webhook(-3)).statusCode, 200);
  assert.equal(f.live.has(f.identity(-3)), false);
});

test("framework errors are translated without exposing implementation details", async (t) => {
  const f = await fixture(t);
  const missing = await f.req("GET", "/api/not-a-route");
  assert.equal(missing.status, 404);
  assert.match(missing.error, /Проверьте приглашение/);
  const malformed = await f.app.inject({
    method: "POST",
    url: "/api/token",
    headers: { "content-type": "application/json" },
    payload: "{bad json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.doesNotMatch(malformed.json().error, /JSON|SyntaxError|Unexpected/);
  assert.match(malformed.json().error, /Обновите страницу/);
  const large = await f.app.inject({
    method: "POST",
    url: "/api/token",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ text: "x".repeat(70000) }),
  });
  assert.equal(large.statusCode, 413);
  assert.match(large.json().error, /Уменьшите размер/);
  let last;
  for (let i = 0; i < 90; i++) last = await f.req("GET", "/api/health");
  assert.equal(last.status, 429);
  assert.match(last.error, /Подождите минуту/);
  assert.doesNotMatch(last.error, /Rate limit/);
});
