import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessToken, TokenVerifier, TrackSource } from "livekit-server-sdk";
import { buildApp } from "../src/index.js";
import { issueSession, participantId } from "../src/security.js";
async function fixture(t, options = {}) {
  let now = options.now || Date.now();
  const secret = "test-management-secret-".repeat(4),
    env = {
      INTERNAL_KEY: secret,
      OWNER_TG_ID: "900",
      LIVEKIT_API_KEY: "testkey",
      LIVEKIT_API_SECRET: "test-media-secret-".repeat(4),
      DOMAIN: "localhost",
      PERSISTENT_ROOMS: options.persistentNames || "|",
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
      reopensAt: null,
    },
    rooms = [room, { ...room, id: 2, code: "OTHERROOM", ownerTgId: -4n }],
    members = [],
    bans = [],
    live = new Map(),
    removed = [],
    mutes = [];
  if (options.persistent) {
    room.isPersistent = true;
    room.ownerTgId = null;
  }
  const mediaRooms = new Map(
    rooms.map((r) => [
      r.code,
      { name: r.code, maxParticipants: options.legacyHardcap || 100 },
    ]),
  );
  const identity = (id, code = "TESTROOM") => participantId(code, id, secret);
  for (const id of [-1, -2, -3, 900])
    members.push({
      roomId: 1,
      identity: identity(id),
      displayName: "Member " + id,
      microphoneBlocked: false,
      allowedWhileLocked: false,
      overLimitAllowed: false,
    });
  members.push({
    roomId: 2,
    identity: identity(-4, "OTHERROOM"),
    displayName: "Other",
  });
  const compare = (value) => (value instanceof Date ? value.getTime() : value);
  const match = (o, w = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === "OR") return v.some((part) => match(o, part));
      if (k === "AND") return v.every((part) => match(o, part));
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if (v.in) return v.in.includes(o[k]);
        if ("not" in v) return o[k] !== v.not;
        if (o[k] == null) return false;
        return Object.entries(v).every(
          ([operator, expected]) =>
            ({
              lt: compare(o[k]) < compare(expected),
              lte: compare(o[k]) <= compare(expected),
              gt: compare(o[k]) > compare(expected),
              gte: compare(o[k]) >= compare(expected),
            })[operator] ?? true,
        );
      }
      return compare(o[k]) === compare(v);
    });
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
      upsert: async ({ where, create, update }) => {
        let record = find(rooms, where);
        if (record) Object.assign(record, update);
        else {
          record = {
            id: rooms.length + 1,
            isActive: true,
            isLocked: false,
            reopensAt: null,
            ...create,
          };
          rooms.push(record);
        }
        return record;
      },
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
    createRoom: async (data) => {
      if (!mediaRooms.has(data.name)) mediaRooms.set(data.name, { ...data });
      return mediaRooms.get(data.name);
    },
    listRooms: async (codes) =>
      [...mediaRooms.values()]
        .filter((r) => !codes?.length || codes.includes(r.name))
        .map((r) => ({
          ...r,
          numParticipants: [...live.values()].filter((p) => p.room === r.name)
            .length,
        })),
    deleteRoom: async (code) => {
      mediaRooms.delete(code);
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
  let app = await buildApp({ env, prisma: db, media, clock: () => now });
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
  const connect = (id, code = "TESTROOM") => {
    live.set(identity(id, code), {
      identity: identity(id, code),
      name: "Member " + id,
      room: code,
      permission: {
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
      },
      tracks: [{ sid: "mic", source: TrackSource.MICROPHONE }],
    });
  };
  const webhook = async (
    id,
    code = "TESTROOM",
    event = "participant_joined",
  ) => {
    const body = JSON.stringify({
        event,
        room: { name: code },
        participant: { identity: identity(id, code) },
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
    rooms,
    members,
    mediaRooms,
    env,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    restart: async () => {
      await app.close();
      app = await buildApp({ env, prisma: db, media, clock: () => now });
      await app.ready();
    },
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

test("service-owner identity comes from verified credentials and never bypasses a private key", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req("GET", "/api/me", -2)).isServiceOwner, false);
  assert.equal((await f.req("GET", "/api/me", -2)).isAnonymous, true);
  assert.deepEqual(await f.req("GET", "/api/me", 900), {
    status: 200,
    isServiceOwner: true,
    isAnonymous: false,
    maxParticipantsLimit: 100,
  });
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/me",
        headers: { "x-anon-id": "900" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.req("POST", "/api/room/create", 900, {
        encrypted: false,
        maxParticipants: 0,
      })
    ).status,
    400,
  );
  let token = await f.req("POST", "/api/token", 900, { room: "OTHERROOM" });
  assert.equal(token.isAdmin, true);
  assert.equal(token.isServiceOwner, true);
  assert.equal(
    JSON.parse((await f.claims(token.token)).metadata).role,
    "service_owner",
  );
  token = await f.req("POST", "/api/token", -2, {
    room: "OTHERROOM",
    isServiceOwner: true,
    isAdmin: true,
  });
  assert.equal(token.isServiceOwner, false);
  assert.equal(token.isAdmin, false);
  const proof = createHash("sha256")
      .update("private-invitation-proof")
      .digest("hex"),
    accessHash = createHash("sha256").update(proof).digest("hex");
  const room = await f.req("POST", "/api/room/create", -1, { accessHash });
  assert.equal(
    (await f.req("POST", "/api/token", 900, { room: room.code })).status,
    403,
  );
  assert.equal(
    (
      await f.req("POST", "/api/token", 900, {
        room: room.code,
        accessProof: proof,
      })
    ).isAdmin,
    true,
  );
});

test("active room limits change without kicking current participants and reject stale over-capacity arrivals", async (t) => {
  const f = await fixture(t);
  for (const id of [-1, -2, 900]) f.connect(id);
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", 900, {
        maxParticipants: 12,
      })
    ).status,
    200,
  );
  assert.equal(f.live.size, 3);
  assert.equal(f.room.maxParticipants, 12);
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: "TESTROOM" })).status,
    200,
  );
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", 900, {
        maxParticipants: 2,
      })
    ).status,
    200,
  );
  assert.equal(f.live.size, 3);
  assert.equal(f.room.maxParticipants, 2);
  assert.equal(
    (await f.req("POST", "/api/token", -3, { room: "TESTROOM" })).status,
    409,
  );
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    200,
  );
  assert.equal((await f.webhook(-2)).statusCode, 200);
  assert.equal(f.live.has(f.identity(-2)), true);
  f.connect(-3);
  assert.equal((await f.webhook(-3)).statusCode, 200);
  assert.equal(f.live.has(f.identity(-3)), false);
  f.live.delete(f.identity(-2));
  await f.webhook(-2, "TESTROOM", "participant_left");
  f.connect(-2);
  await f.webhook(-2);
  assert.equal(f.live.has(f.identity(-2)), false);
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", -1, {
        maxParticipants: 9,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", -3, {
        maxParticipants: 2,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", 900, {
        maxParticipants: 101,
      })
    ).status,
    400,
  );
  const state = await f.req("GET", "/api/room/TESTROOM/moderation", 900);
  assert.equal(state.maxParticipants, 2);
  assert.equal(state.maxAllowedParticipants, 100);
});

test("legacy media hard limits are upgraded only when the old room is empty", async (t) => {
  const f = await fixture(t, { legacyHardcap: 8 });
  f.connect(-2);
  const result = await f.req("PUT", "/api/admin/room/TESTROOM/limit", 900, {
    maxParticipants: 12,
  });
  assert.equal(result.status, 409);
  assert.match(result.error, /Текущий разговор не будет прерван/);
  assert.equal(f.live.size, 1);
  assert.equal(f.room.maxParticipants, 8);
  f.live.clear();
  assert.equal(
    (
      await f.req("PUT", "/api/admin/room/TESTROOM/limit", 900, {
        maxParticipants: 12,
      })
    ).status,
    200,
  );
  assert.equal(f.mediaRooms.get("TESTROOM").maxParticipants, 100);
});

test("all public rooms remain listed during a persisted five-minute restart; custom limits survive API restarts", async (t) => {
  const f = await fixture(t, {
    persistentNames: "Общая 1|Общая 2|Общая 3",
    now: Date.now(),
  });
  let listing = await f.req("GET", "/api/rooms/public");
  assert.equal(listing.rooms.length, 3);
  const target = listing.rooms[0],
    code = encodeURIComponent(target.code),
    record = f.rooms.find((r) => r.code === target.code);
  assert.equal(
    (await f.req("POST", `/api/room/${code}/close`, -1, {})).status,
    403,
  );
  await f.req("PUT", `/api/admin/room/${code}/limit`, 900, {
    maxParticipants: 17,
  });
  const started = f.now(),
    closed = await f.req("POST", `/api/admin/room/${code}/close`, 900, {});
  assert.equal(closed.status, 200);
  assert.equal(new Date(closed.reopensAt).getTime() - started, 300000);
  const deadline = new Date(closed.reopensAt).getTime();
  assert.equal(record.isActive, false);
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: target.code })).status,
    410,
  );
  listing = await f.req("GET", "/api/rooms/public");
  assert.equal(listing.rooms.length, 3);
  assert.equal(
    listing.rooms.find((r) => r.code === target.code).isActive,
    false,
  );
  assert.equal(
    listing.rooms.find((r) => r.code === target.code).participantCount,
    0,
  );
  const ownerListing = await f.req("GET", "/api/admin/rooms", 900);
  assert.equal(
    ownerListing.rooms.find((r) => r.code === target.code).maxParticipants,
    17,
  );
  await f.req("PUT", `/api/admin/room/${code}/limit`, 900, {
    maxParticipants: 19,
  });
  await f.restart();
  assert.equal(record.maxParticipants, 19);
  assert.equal(record.isActive, false);
  assert.equal(new Date(record.reopensAt).getTime(), deadline);
  f.advance(299999);
  await f.req("GET", "/api/rooms/public");
  assert.equal(record.isActive, false);
  f.advance(1);
  listing = await f.req("GET", "/api/rooms/public");
  assert.equal(record.isActive, true);
  assert.equal(record.reopensAt, null);
  assert.equal(record.maxParticipants, 19);
  assert.equal(listing.rooms.length, 3);
  assert.equal(f.mediaRooms.get(target.code).maxParticipants, 100);
  const stillPrivate = await f.req("POST", "/api/room/TESTROOM/close", -1, {});
  assert.equal(stillPrivate.reopensAt, null);
  f.advance(600000);
  await f.restart();
  assert.equal(
    (await f.req("POST", "/api/token", -2, { room: "TESTROOM" })).status,
    410,
  );
});
