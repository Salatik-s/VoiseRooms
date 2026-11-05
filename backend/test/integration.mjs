// Real PostgreSQL and LiveKit smoke test. Run only against a disposable test database.
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/index.js";
import { TokenVerifier } from "livekit-server-sdk";
import { randomBytes, createHash } from "node:crypto";
if (!String(process.env.DATABASE_URL).includes("voicerooms_test"))
  throw Error("Requires isolated voicerooms_test database");
const db = new PrismaClient();
let app = await buildApp({ prisma: db });
await app.ready();
let checks = 0;
const accessProof = createHash("sha256")
  .update("VoiceRooms admission v1:" + "A".repeat(43))
  .digest("hex");
const accessHash = createHash("sha256").update(accessProof).digest("hex");
async function req(method, url, headers = {}, payload) {
  const r = await app.inject({ method, url, headers, payload });
  return { status: r.statusCode, data: r.json() };
}
try {
  const guest = (await req("GET", "/api/session")).data.token,
    other = (await req("GET", "/api/session")).data.token;
  const own = { authorization: "Bearer " + guest },
    foreign = { authorization: "Bearer " + other };
  assert.equal((await req("GET", "/api/ready")).status, 200);
  checks++;
  assert.equal(
    (
      await req("GET", "/api/admin/rooms", {
        "x-admin-key": process.env.OWNER_TG_ID,
      })
    ).status,
    401,
  );
  checks++;
  assert.equal(
    (
      await req(
        "POST",
        "/api/room/create",
        { "x-anon-id": process.env.OWNER_TG_ID },
        {},
      )
    ).status,
    401,
  );
  checks++;
  const r = (
    await req("POST", "/api/room/create", own, {
      maxParticipants: 3,
      accessHash,
    })
  ).data;
  assert.match(r.code, /^[A-Z2-9]{8}$/);
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code })).status,
    403,
  );
  checks++;
  assert.equal((await req("POST", "/api/room/create", own, {})).status, 400);
  checks++;
  checks++;
  const minted = await req("POST", "/api/token", foreign, {
    room: r.code,
    accessProof,
    isAdmin: true,
    requestOwner: true,
  });
  assert.equal(minted.status, 200);
  assert.equal(minted.data.isAdmin, false);
  checks++;
  const claims = await new TokenVerifier(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  ).verify(minted.data.token);
  assert.equal(claims.video.roomAdmin, false);
  assert.equal(claims.video.room, r.code);
  assert.ok(claims.exp);
  checks++;
  assert.equal(
    (await req("POST", `/api/room/${r.code}/close`, foreign, {})).status,
    403,
  );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/name`, own, {
        displayName: "Name",
      })
    ).status,
    403,
  );
  checks++;
  assert.equal(
    (
      await req("PUT", `/api/admin/room/${r.code}/limit`, own, {
        maxParticipants: "oops",
      })
    ).status,
    400,
  );
  checks++;
  const global = {
    "x-internal-key": process.env.INTERNAL_KEY,
    "x-user-data": JSON.stringify({ id: Number(process.env.OWNER_TG_ID) }),
  };
  const code = (await req("POST", "/api/admin/pair/code", global, {})).data
    .code;
  const paired = await req("POST", "/api/admin/pair", {}, { code });
  assert.equal(paired.status, 200);
  assert.equal(
    (await req("POST", "/api/admin/pair", {}, { code })).status,
    401,
  );
  checks++;
  assert.equal(
    (
      await req("GET", "/api/admin/rooms", {
        authorization: "Bearer " + paired.data.token,
      })
    ).status,
    200,
  );
  checks++;
  const asOwner = (
    await req(
      "POST",
      "/api/token",
      { authorization: "Bearer " + paired.data.token },
      { room: r.code, accessProof },
    )
  ).data;
  const ownerClaims = await new TokenVerifier(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  ).verify(asOwner.token);
  assert.equal(JSON.parse(ownerClaims.metadata).role, "service_owner");
  assert.equal(ownerClaims.name, "Владелец сервиса");
  checks++;
  const plaintext = Buffer.from("private-file-test"),
    iv = randomBytes(12),
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    ),
    cipher = Buffer.from(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
    );
  const boundary = "voicerooms-test",
    payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="encrypted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      cipher,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  const upload = await app.inject({
    method: "POST",
    url: `/api/room/${r.code}/upload`,
    headers: {
      ...foreign,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(upload.statusCode, 200);
  const file = upload.json();
  checks++;
  const outsider = {
    authorization: "Bearer " + (await req("GET", "/api/session")).data.token,
  };
  assert.equal((await req("GET", file.url, outsider)).status, 403);
  checks++;
  const downloaded = await app.inject({
    method: "GET",
    url: file.url,
    headers: foreign,
  });
  assert.equal(downloaded.statusCode, 200);
  assert.deepEqual(downloaded.rawPayload, cipher);
  assert.deepEqual(
    Buffer.from(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        downloaded.rawPayload,
      ),
    ),
    plaintext,
  );
  checks++;
  await db.fileUpload.update({
    where: { id: file.fileId },
    data: { expiresAt: new Date(0) },
  });
  assert.equal((await req("GET", file.url, foreign)).status, 410);
  checks++;
  const ident = minted.data.identity;
  // Exercise persistent moderation against the actual PostgreSQL schema and LiveKit API.
  for (const action of ["mute", "kick", "ban", "unban", "lock"])
    assert.equal(
      (
        await req("POST", `/api/room/${r.code}/${action}`, foreign, {
          targetIdentity: ident,
          muted: true,
          locked: true,
        })
      ).status,
      403,
    );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/mute`, own, {
        targetIdentity: ident,
        muted: true,
      })
    ).status,
    200,
  );
  const restricted = await req("POST", "/api/token", foreign, {
    room: r.code,
    accessProof,
  });
  const restrictedClaims = await new TokenVerifier(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  ).verify(restricted.data.token);
  assert.equal(
    restrictedClaims.video.canPublishSources.includes("microphone"),
    false,
  );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/mute`, own, {
        targetIdentity: ident,
        muted: false,
      })
    ).status,
    200,
  );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/kick`, own, {
        targetIdentity: ident,
      })
    ).status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    200,
  );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/ban`, own, {
        targetIdentity: ident,
      })
    ).status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    403,
  );
  checks++;
  assert.equal(
    (await req("GET", `/api/room/${r.code}/moderation`, own)).data.bans[0]
      .identity,
    ident,
  );
  checks++;
  assert.equal(
    (
      await req("POST", `/api/room/${r.code}/unban`, own, {
        targetIdentity: ident,
      })
    ).status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    200,
  );
  checks++;
  assert.equal(
    (await req("POST", `/api/room/${r.code}/lock`, own, { locked: true }))
      .status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    403,
  );
  assert.equal(
    (await req("POST", "/api/token", own, { room: r.code, accessProof }))
      .status,
    200,
  );
  checks++;
  assert.equal(
    (await req("POST", `/api/room/${r.code}/lock`, own, { locked: false }))
      .status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    200,
  );
  checks++;

  await db.roomBan.create({
    data: {
      roomId: (await db.room.findUnique({ where: { code: r.code } })).id,
      identity: ident,
    },
  });
  assert.equal(
    (await req("POST", "/api/token", foreign, { room: r.code, accessProof }))
      .status,
    403,
  );
  checks++;
  assert.equal(
    (
      await req(
        "POST",
        "/api/livekit/webhook",
        { "content-type": "application/webhook+json" },
        "{}",
      )
    ).status,
    401,
  );
  checks++;
  await db.room.update({
    where: { code: r.code },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    (await req("POST", "/api/token", own, { room: r.code, accessProof }))
      .status,
    410,
  );
  checks++;
  await db.room.update({
    where: { code: r.code },
    data: { expiresAt: new Date(Date.now() + 60000) },
  });
  assert.equal(
    (await req("POST", `/api/room/${r.code}/close`, own, {})).status,
    200,
  );
  assert.equal(
    (await req("POST", "/api/token", own, { room: r.code, accessProof }))
      .status,
    410,
  );
  checks++;
  // Persistent public-room behavior uses a disposable named row, never a production room.
  const publicCode = "PUBLIC-RESTART-" + randomBytes(5).toString("hex");
  const publicRecord = await db.room.create({
    data: {
      code: publicCode,
      name: "Проверка перезапуска",
      isPersistent: true,
      encrypted: false,
      maxParticipants: 3,
    },
  });
  const publicPath = encodeURIComponent(publicCode);
  try {
    const me = await req("GET", "/api/me", global);
    assert.equal(me.data.isServiceOwner, true);
    assert.equal(me.data.maxParticipantsLimit, 100);
    assert.equal(
      (await req("GET", "/api/me", foreign)).data.isServiceOwner,
      false,
    );
    checks++;
    assert.equal(
      (
        await req("PUT", `/api/admin/room/${publicPath}/limit`, global, {
          maxParticipants: 19,
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.room.findUnique({ where: { id: publicRecord.id } }))
        .maxParticipants,
      19,
    );
    checks++;
    const beforeClose = Date.now(),
      closed = await req(
        "POST",
        `/api/admin/room/${publicPath}/close`,
        global,
        {},
      );
    assert.equal(closed.status, 200);
    assert.ok(Date.parse(closed.data.reopensAt) >= beforeClose + 299000);
    assert.equal(
      (await req("POST", "/api/token", foreign, { room: publicCode })).status,
      410,
    );
    checks++;
    let listed = (await req("GET", "/api/rooms/public")).data.rooms.find(
      (item) => item.code === publicCode,
    );
    assert.equal(listed.isActive, false);
    assert.ok(listed.reopensAt);
    assert.equal(listed.participantCount, 0);
    checks++;
    assert.equal(
      (
        await req("PUT", `/api/admin/room/${publicPath}/limit`, global, {
          maxParticipants: 23,
        })
      ).status,
      200,
    );
    checks++;
    // Advance only the disposable row's persisted deadline; don't wait five real minutes.
    await db.room.update({
      where: { id: publicRecord.id },
      data: { reopensAt: new Date(Date.now() - 1000) },
    });
    await app.close();
    app = await buildApp({ prisma: db });
    await app.ready();
    const reopened = await db.room.findUnique({
      where: { id: publicRecord.id },
    });
    assert.equal(reopened.isActive, true);
    assert.equal(reopened.reopensAt, null);
    assert.equal(reopened.maxParticipants, 23);
    checks++;
    listed = (await req("GET", "/api/rooms/public")).data.rooms.find(
      (item) => item.code === publicCode,
    );
    assert.equal(listed.isActive, true);
    assert.equal(listed.maxParticipants, 23);
    checks++;
    const joined = await req("POST", "/api/token", global, {
      room: publicCode,
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.isServiceOwner, true);
    checks++;
  } finally {
    // Delete the isolated media row before its database record; no user rooms are affected.
    const { RoomServiceClient } = await import("livekit-server-sdk");
    await new RoomServiceClient(
      process.env.LIVEKIT_HOST,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    )
      .deleteRoom(publicCode)
      .catch(() => {});
    await db.roomParticipantName.deleteMany({
      where: { roomId: publicRecord.id },
    });
    await db.room.delete({ where: { id: publicRecord.id } });
  }
  console.log(
    JSON.stringify({
      passed: checks,
      database: "real PostgreSQL",
      media: "real LiveKit",
      secretsPrinted: false,
    }),
  );
} finally {
  await app.close();
}
