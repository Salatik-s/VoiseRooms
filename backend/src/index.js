import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { PrismaClient } from "@prisma/client";
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
} from "livekit-server-sdk";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, unlink, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyInitData } from "./telegram-auth.js";
import {
  sameSecret,
  issueSession,
  readSession,
  guestId,
  participantId,
  roomCode,
  isActive,
} from "./security.js";

export async function buildApp({
  env = process.env,
  prisma = new PrismaClient(),
  media,
  clock = () => Date.now(),
} = {}) {
  const secret = env.INTERNAL_KEY;
  if (!secret || secret.length < 32)
    throw Error("INTERNAL_KEY must contain at least 32 characters");
  const owner = Number(env.OWNER_TG_ID || 0),
    host = env.LIVEKIT_HOST || "http://127.0.0.1:7880";
  const maximum = Number(env.MAX_ROOM_PARTICIPANTS || 8);
  if (!Number.isInteger(maximum) || maximum < 2 || maximum > 100)
    throw Error("MAX_ROOM_PARTICIPANTS must be 2..100");
  const ownerMaximum = Number(env.MAX_OWNER_ROOM_PARTICIPANTS || 100);
  if (
    !Number.isInteger(ownerMaximum) ||
    ownerMaximum < maximum ||
    ownerMaximum > 100
  )
    throw Error(
      "MAX_OWNER_ROOM_PARTICIPANTS must be MAX_ROOM_PARTICIPANTS..100",
    );
  const lk =
    media ||
    new RoomServiceClient(
      /^https?:/.test(host) ? host : "http://" + host,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
  const app = Fastify({
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.x-internal-key",
        "req.headers.x-telegram-init-data",
        "req.headers.x-admin-key",
      ],
    },
    bodyLimit: 65536,
  });
  const origin = env.APP_ORIGIN || "https://" + env.DOMAIN,
    uploads = resolve(env.UPLOADS_DIR || "uploads");
  await mkdir(uploads, { recursive: true });
  await app.register(cors, { origin: [origin], credentials: false });
  await app.register(rateLimit, { max: 80, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    return payload;
  });
  const fail = (code, message) =>
    Object.assign(new Error(message), {
      statusCode: code,
      publicMessage: message,
    });
  const errorText = {
    400: "Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.",
    401: "Сессия истекла. Откройте комнату заново.",
    403: "У вас нет доступа к этому действию.",
    404: "Комната не найдена. Проверьте приглашение.",
    409: "Действие сейчас недоступно. Попробуйте ещё раз.",
    410: "Комната закрыта или срок приглашения истёк.",
    413: "Файл или сообщение слишком большие. Уменьшите размер и попробуйте снова.",
    415: "Не удалось прочитать запрос. Обновите страницу и попробуйте ещё раз.",
    429: "Слишком много попыток. Подождите минуту и попробуйте снова.",
  };
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: errorText[404] }),
  );
  app.setErrorHandler((e, req, reply) => {
    const code = e.statusCode || 500;
    reply.code(code).send({
      error:
        code >= 500
          ? "Сервис временно недоступен. Попробуйте позже."
          : e.publicMessage ||
            errorText[code] ||
            "Не удалось выполнить действие. Попробуйте ещё раз.",
    });
    if (code >= 500)
      app.log.error(
        { type: e.name, code: e.code || "UNKNOWN" },
        "Request failed",
      );
  });
  async function user(req) {
    let u;
    const internal = req.headers["x-internal-key"];
    if (internal) {
      if (!sameSecret(String(internal), secret))
        throw fail(401, "Недействительная авторизация");
      try {
        const p = JSON.parse(req.headers["x-user-data"] || "{}");
        if (!Number.isSafeInteger(p.id) || p.id <= 0) throw Error();
        u = { id: p.id };
      } catch {
        throw fail(401, "Недействительные данные пользователя");
      }
    } else if (req.headers["x-telegram-init-data"]) {
      u = verifyInitData(req.headers["x-telegram-init-data"], env.BOT_TOKEN);
      if (!u) throw fail(401, "Откройте Mini App заново");
    } else {
      const token =
        String(req.headers.authorization || "").replace(/^Bearer /, "") ||
        req.headers["x-admin-key"];
      const s = readSession(token, secret);
      if (!s || (s.id > 0 && !(s.admin && s.id === owner)))
        throw fail(401, "Сессия истекла. Войдите заново");
      u = { id: s.id, isAnonymous: s.id < 0 };
    }
    await prisma.user.upsert({
      where: { tgId: BigInt(u.id) },
      create: { tgId: BigInt(u.id), lang: "ru" },
      update: { lastSeenAt: new Date() },
    });
    return u;
  }
  const idFor = (room, u) => participantId(room, u.id, secret);
  const publicRoom = (r) => ({
    code: r.code,
    name: r.name,
    isPersistent: r.isPersistent,
    isActive: isActive(r),
    isLocked: r.isLocked,
    encrypted: r.encrypted,
    maxParticipants: r.maxParticipants,
    expiresAt: r.expiresAt,
    reopensAt: r.reopensAt || null,
  });
  const pendingRestart = (r) =>
    !!r?.isPersistent && !r.isActive && !!r.reopensAt;
  const restarting = new Map();
  let shuttingDown = false;
  async function deleteMediaRoom(code) {
    await lk.deleteRoom(code).catch((e) => {
      if (e.status !== 404 && e.code !== "not_found") throw e;
    });
  }
  const createMediaRoom = (code) =>
    lk.createRoom({
      name: code,
      maxParticipants: ownerMaximum,
      emptyTimeout: 300,
    });
  async function reopenDueRooms() {
    if (shuttingDown) return;
    const due = await prisma.room.findMany({
      where: {
        isPersistent: true,
        isActive: false,
        reopensAt: { lte: new Date(clock()) },
      },
    });
    if (shuttingDown) return;
    for (const candidate of due) {
      if (shuttingDown) return;
      if (restarting.has(candidate.code)) {
        await restarting.get(candidate.code);
        continue;
      }
      const operation = (async () => {
        const current = await prisma.room.findUnique({
          where: { id: candidate.id },
        });
        if (
          !pendingRestart(current) ||
          new Date(current.reopensAt).getTime() > clock()
        )
          return;
        await deleteMediaRoom(current.code);
        await createMediaRoom(current.code);
        await prisma.$transaction(async (tx) => {
          await tx.roomParticipantName.updateMany({
            where: { roomId: current.id },
            data: { allowedWhileLocked: false, overLimitAllowed: false },
          });
          // A restart clears the call, while explicit participant bans remain until removed.
          await tx.room.update({
            where: { id: current.id },
            data: { isActive: true, isLocked: false, reopensAt: null },
          });
        });
      })();
      restarting.set(candidate.code, operation);
      try {
        await operation;
      } finally {
        restarting.delete(candidate.code);
      }
    }
  }
  async function room(code, allowRestarting = false) {
    let r = await prisma.room.findUnique({ where: { code } });
    if (!r) throw fail(404, "Комната не найдена");
    if (pendingRestart(r) && new Date(r.reopensAt).getTime() <= clock()) {
      await reopenDueRooms();
      r = await prisma.room.findUnique({ where: { code } });
    }
    if (!isActive(r) && !(allowRestarting && pendingRestart(r)))
      throw fail(
        410,
        pendingRestart(r)
          ? "Публичная комната перезапускается. Дождитесь окончания перезапуска."
          : "Комната закрыта или срок приглашения истёк",
      );
    return r;
  }
  async function admin(req, code, allowRestarting = false) {
    const u = await user(req),
      r = await room(code, allowRestarting);
    if (u.id !== owner && r.ownerTgId !== BigInt(u.id))
      throw fail(403, "Управлять комнатой может только её создатель");
    return { u, r };
  }
  async function ensureMediaRoom(
    r,
    requestedLimit = r.maxParticipants,
    connected,
  ) {
    const existing = (await lk.listRooms([r.code])).find(
      (item) => item.name === r.code,
    );
    if (!existing) return createMediaRoom(r.code);
    // Older deployed rooms may still have a smaller immutable media hard limit.
    if (
      existing.maxParticipants > 0 &&
      existing.maxParticipants < requestedLimit
    ) {
      const people = connected || (await lk.listParticipants(r.code));
      if (people.length)
        throw fail(
          409,
          "Чтобы увеличить лимит этой комнаты, дождитесь выхода участников и повторите действие. Текущий разговор не будет прерван.",
        );
      await deleteMediaRoom(r.code);
      return createMediaRoom(r.code);
    }
    return existing;
  }
  const publishSources = (blocked) => [
    ...(!blocked ? [TrackSource.MICROPHONE] : []),
    TrackSource.SCREEN_SHARE,
    TrackSource.SCREEN_SHARE_AUDIO,
  ];
  const managerIdentity = (r, identity) =>
    (r.ownerTgId !== null &&
      identity === idFor(r.code, { id: Number(r.ownerTgId) })) ||
    (owner > 0 && identity === idFor(r.code, { id: owner }));
  async function targetMember(r, u, target) {
    if (
      !/^[a-f0-9]{24}$/.test(target) ||
      target === idFor(r.code, u) ||
      managerIdentity(r, target)
    )
      throw fail(400, "Выберите участника без прав управления комнатой");
    const member = await prisma.roomParticipantName.findUnique({
      where: { roomId_identity: { roomId: r.id, identity: target } },
    });
    if (!member) throw fail(404, "Участник не найден в этой комнате");
    return member;
  }
  async function removeParticipant(code, identity) {
    await lk.removeParticipant(code, identity).catch((e) => {
      if (e.status !== 404 && e.code !== "not_found") throw e;
    });
  }
  async function enforceMicrophone(r, identity, blocked) {
    const p = await lk.getParticipant(r.code, identity).catch((e) => {
      if (e.status === 404 || e.code === "not_found") return null;
      throw e;
    });
    if (!p) return;
    await lk.updateParticipant(r.code, identity, {
      permission: {
        ...p.permission,
        canPublish: true,
        canPublishSources: publishSources(blocked),
        canPublishData: true,
      },
    });
    // Restoring permission never turns another person's microphone on.
    if (blocked)
      for (const track of p.tracks || [])
        if (track.source === TrackSource.MICROPHONE)
          await lk.mutePublishedTrack(r.code, identity, track.sid, true);
  }
  async function globalAdmin(req) {
    const u = await user(req);
    if (!owner || u.id !== owner) throw fail(403, "Доступ только владельцу");
    return u;
  }
  async function member(req, code) {
    const u = await user(req),
      r = await room(code),
      identity = idFor(code, u);
    const m = await prisma.roomParticipantName.findUnique({
      where: { roomId_identity: { roomId: r.id, identity } },
    });
    if (
      !m ||
      (await prisma.roomBan.findUnique({
        where: { roomId_identity: { roomId: r.id, identity } },
      }))
    )
      throw fail(403, "Сначала войдите в комнату");
    return { u, r, identity };
  }
  app.get(
    "/api/session",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async () => ({ token: issueSession(guestId(), secret) }),
  );
  app.get("/api/me", async (req) => {
    const u = await user(req),
      isServiceOwner = owner > 0 && u.id === owner;
    return {
      isServiceOwner,
      isAnonymous: u.id < 0,
      maxParticipantsLimit: isServiceOwner ? ownerMaximum : maximum,
    };
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/ready", async () => {
    await prisma.$queryRaw`SELECT 1`;
    await lk.listRooms([]);
    return { status: "ok", database: true, media: true };
  });
  const pairs = new Map();
  const hash = (v) => createHash("sha256").update(v).digest("hex");
  const receiver = new WebhookReceiver(
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );
  app.post("/api/livekit/webhook", async (req, reply) => {
    let event;
    try {
      event = await receiver.receive(req.body, req.headers.authorization);
    } catch {
      throw fail(401, "Недействительная подпись события");
    }
    if (
      event.event === "participant_left" &&
      event.room?.name &&
      event.participant?.identity
    ) {
      const r = await prisma.room.findUnique({
        where: { code: event.room.name },
      });
      if (r)
        await prisma.roomParticipantName.updateMany({
          where: { roomId: r.id, identity: event.participant.identity },
          data: { overLimitAllowed: false },
        });
    }
    if (
      event.event === "participant_joined" &&
      event.room?.name &&
      event.participant?.identity
    ) {
      const r = await prisma.room.findUnique({
        where: { code: event.room.name },
      });
      const identity = event.participant.identity;
      const record =
        r &&
        (await prisma.roomParticipantName.findUnique({
          where: { roomId_identity: { roomId: r.id, identity } },
        }));
      if (
        !isActive(r) ||
        !record ||
        (await prisma.roomBan.findUnique({
          where: { roomId_identity: { roomId: r.id, identity } },
        })) ||
        (r.isLocked &&
          !record.allowedWhileLocked &&
          !managerIdentity(r, identity))
      ) {
        await removeParticipant(event.room.name, identity);
      } else {
        const connected = await lk.listParticipants(r.code);
        if (connected.length > r.maxParticipants && !record.overLimitAllowed)
          await removeParticipant(r.code, identity);
        else
          // Re-check persisted restrictions even for a media JWT minted before moderation.
          await enforceMicrophone(r, identity, record.microphoneBlocked);
      }
    }
    return reply.code(200).send({ ok: true });
  });
  app.post("/api/admin/pair/code", async (req) => {
    await globalAdmin(req);
    for (const [k, v] of pairs) if (v < Date.now()) pairs.delete(k);
    if (pairs.size > 100) throw fail(429, "Попробуйте позже");
    const code = randomBytes(6).toString("hex").toUpperCase();
    pairs.set(hash(code), Date.now() + 300000);
    return { code, expiresIn: 300 };
  });
  app.post(
    "/api/admin/pair",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const h = hash(
          String(req.body?.code || "")
            .replace(/\s/g, "")
            .toUpperCase(),
        ),
        exp = pairs.get(h);
      if (!exp || exp < Date.now())
        throw fail(401, "Неверный или просроченный код");
      pairs.delete(h);
      return { token: issueSession(owner, secret, true) };
    },
  );
  app.post(
    "/api/room/create",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const u = await user(req),
        body = req.body || {},
        code = roomCode(),
        ceiling = u.id === owner ? ownerMaximum : maximum,
        limit = Number(body.maxParticipants ?? maximum);
      if (!Number.isInteger(limit) || limit < 2 || limit > ceiling)
        throw fail(400, "Лимит участников: от 2 до " + ceiling);
      if (
        (await prisma.room.count({
          where: {
            isPersistent: false,
            isActive: true,
            expiresAt: { gt: new Date() },
          },
        })) >= Number(env.MAX_ACTIVE_ROOMS || 20)
      )
        throw fail(429, "Все комнаты заняты. Попробуйте позже");
      const name = String(body.name || "Комната " + code)
          .trim()
          .slice(0, 60),
        encrypted = body.encrypted !== false;
      const accessHash = encrypted ? String(body.accessHash || "") : null;
      if (encrypted && !/^[a-f0-9]{64}$/.test(accessHash))
        throw fail(
          400,
          "Для приватной комнаты нужен защищённый ключ приглашения",
        );
      await createMediaRoom(code);
      try {
        const r = await prisma.room.create({
          data: {
            code,
            name,
            ownerTgId: BigInt(u.id),
            maxParticipants: limit,
            encrypted,
            accessHash,
            expiresAt: new Date(Date.now() + 4 * 3600000),
          },
        });
        return { ...publicRoom(r), isOwner: true };
      } catch (e) {
        await lk.deleteRoom(code).catch(() => {});
        throw e;
      }
    },
  );
  app.post("/api/room/join", async (req) => {
    await user(req);
    return publicRoom(await room(String(req.body?.code || "").trim(), true));
  });
  app.get("/api/room/:code", async (req) =>
    publicRoom(await room(req.params.code, true)),
  );
  app.post("/api/token", async (req) => {
    const u = await user(req),
      r = await room(String(req.body?.room || req.body?.roomCode || "")),
      identity = idFor(r.code, u);
    if (r.encrypted) {
      if (!r.accessHash)
        throw fail(
          410,
          "Комната создана прежней версией. Создайте новое приглашение.",
        );
      const proof = String(req.body?.accessProof || "");
      if (
        !/^[a-f0-9]{64}$/.test(proof) ||
        !sameSecret(hash(proof), r.accessHash)
      )
        throw fail(403, "Нужна полная ссылка-приглашение с верным ключом");
    }
    if (
      await prisma.roomBan.findUnique({
        where: { roomId_identity: { roomId: r.id, identity } },
      })
    )
      throw fail(403, "Вход в эту комнату заблокирован");
    const existing = await prisma.roomParticipantName.findUnique({
      where: { roomId_identity: { roomId: r.id, identity } },
    });
    if (
      r.isLocked &&
      !existing?.allowedWhileLocked &&
      !managerIdentity(r, identity)
    )
      throw fail(403, "Вход в комнату закрыт создателем");
    const name =
        existing?.displayName ||
        (u.id === owner
          ? "Владелец сервиса"
          : "Гость " + identity.slice(0, 4).toUpperCase()),
      isAdmin = u.id === owner || r.ownerTgId === BigInt(u.id);
    await ensureMediaRoom(r);
    const connected = await lk.listParticipants(r.code);
    if (
      !connected.some((p) => p.identity === identity) &&
      connected.length >= r.maxParticipants
    )
      throw fail(
        409,
        "В комнате нет свободных мест. Дождитесь, пока кто-нибудь выйдет, или попросите увеличить лимит.",
      );
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity,
      name,
      metadata: JSON.stringify({
        role:
          u.id === owner
            ? "service_owner"
            : r.ownerTgId === BigInt(u.id)
              ? "room_owner"
              : "guest",
      }),
      ttl: 300,
    });
    at.addGrant({
      room: r.code,
      roomJoin: true,
      roomAdmin: false,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: publishSources(existing?.microphoneBlocked),
    });
    const token = await at.toJwt();
    await prisma.roomParticipantName.upsert({
      where: { roomId_identity: { roomId: r.id, identity } },
      create: { roomId: r.id, identity, displayName: name },
      update: {},
    });
    return {
      token,
      livekitUrl: env.LIVEKIT_PUBLIC_URL || "wss://" + env.DOMAIN + "/livekit/",
      room: r.code,
      identity,
      isAdmin,
      isOwner: isAdmin,
      isServiceOwner: owner > 0 && u.id === owner,
      microphoneBlocked: existing?.microphoneBlocked || false,
      encrypted: r.encrypted,
      maxParticipants: r.maxParticipants,
    };
  });
  async function close(req) {
    const { r } = await admin(req, req.params.code);
    const reopensAt = r.isPersistent ? new Date(clock() + 300000) : null;
    // Persist the deadline first so it survives a process restart or media failure.
    await prisma.room.update({
      where: { id: r.id },
      data: { isActive: false, isLocked: false, reopensAt },
    });
    await deleteMediaRoom(r.code);
    return { success: true, reopensAt };
  }
  app.post("/api/room/:code/close", close);
  app.post("/api/admin/room/:code/close", close);
  app.post("/api/room/:code/kick", async (req) => {
    const { u, r } = await admin(req, req.params.code),
      target = String(req.body?.targetIdentity || "");
    await targetMember(r, u, target);
    await prisma.roomParticipantName.update({
      where: { roomId_identity: { roomId: r.id, identity: target } },
      data: { allowedWhileLocked: false },
    });
    await removeParticipant(r.code, target);
    return { success: true };
  });
  app.post("/api/room/:code/ban", async (req) => {
    const { u, r } = await admin(req, req.params.code),
      target = String(req.body?.targetIdentity || "");
    await targetMember(r, u, target);
    await prisma.roomBan.upsert({
      where: { roomId_identity: { roomId: r.id, identity: target } },
      create: { roomId: r.id, identity: target },
      update: {},
    });
    await removeParticipant(r.code, target);
    return { success: true };
  });
  app.post("/api/room/:code/unban", async (req) => {
    const { u, r } = await admin(req, req.params.code),
      target = String(req.body?.targetIdentity || "");
    await targetMember(r, u, target);
    await prisma.roomBan.deleteMany({
      where: { roomId: r.id, identity: target },
    });
    return { success: true };
  });
  app.post("/api/room/:code/mute", async (req) => {
    const { u, r } = await admin(req, req.params.code),
      target = String(req.body?.targetIdentity || "");
    await targetMember(r, u, target);
    if (typeof req.body?.muted !== "boolean")
      throw fail(400, "Укажите состояние микрофона");
    const muted = req.body.muted;
    await prisma.roomParticipantName.update({
      where: { roomId_identity: { roomId: r.id, identity: target } },
      data: { microphoneBlocked: muted },
    });
    await enforceMicrophone(r, target, muted);
    return { success: true, muted };
  });
  app.get("/api/room/:code/moderation", async (req) => {
    const { u, r } = await admin(req, req.params.code);
    const [bans, names] = await Promise.all([
      prisma.roomBan.findMany({ where: { roomId: r.id } }),
      prisma.roomParticipantName.findMany({ where: { roomId: r.id } }),
    ]);
    return {
      isLocked: r.isLocked,
      isPersistent: r.isPersistent,
      maxParticipants: r.maxParticipants,
      maxAllowedParticipants: u.id === owner ? ownerMaximum : maximum,
      members: names.map((n) => ({
        identity: n.identity,
        microphoneBlocked: n.microphoneBlocked,
      })),
      bans: bans.map((b) => ({
        identity: b.identity,
        name:
          names.find((n) => n.identity === b.identity)?.displayName || "Гость",
      })),
    };
  });
  app.post("/api/room/:code/lock", async (req) => {
    const { r } = await admin(req, req.params.code);
    if (typeof req.body?.locked !== "boolean")
      throw fail(400, "Укажите состояние входа");
    const locked = req.body.locked;
    if (r.isLocked === locked) return { success: true, isLocked: locked };
    const admitted = locked
      ? (await lk.listParticipants(r.code)).map((p) => p.identity)
      : [];
    await prisma.$transaction(async (tx) => {
      await tx.roomParticipantName.updateMany({
        where: { roomId: r.id },
        data: { allowedWhileLocked: false },
      });
      if (locked && admitted.length)
        await tx.roomParticipantName.updateMany({
          where: { roomId: r.id, identity: { in: admitted } },
          data: { allowedWhileLocked: true },
        });
      await tx.room.update({ where: { id: r.id }, data: { isLocked: locked } });
    });
    // Close the window between the media snapshot and the database transaction.
    if (locked)
      for (const p of await lk.listParticipants(r.code))
        if (!admitted.includes(p.identity) && !managerIdentity(r, p.identity))
          await removeParticipant(r.code, p.identity);
    return { success: true, isLocked: locked };
  });
  app.get("/api/rooms/public", async () => {
    await reopenDueRooms();
    const records = await prisma.room.findMany({
        where: { isPersistent: true },
        orderBy: { id: "asc" },
      }),
      active = records.filter((r) => isActive(r)),
      live = active.length ? await lk.listRooms(active.map((r) => r.code)) : [];
    return {
      rooms: records.map((r) => ({
        ...publicRoom(r),
        participantCount: isActive(r)
          ? live.find((l) => l.name === r.code)?.numParticipants || 0
          : 0,
      })),
    };
  });
  app.get("/api/admin/rooms", async (req) => {
    await globalAdmin(req);
    await reopenDueRooms();
    const records = (
        await prisma.room.findMany({
          where: { OR: [{ isActive: true }, { isPersistent: true }] },
          orderBy: { id: "asc" },
        })
      ).filter((r) => isActive(r) || pendingRestart(r)),
      active = records.filter((r) => isActive(r)),
      live = active.length ? await lk.listRooms(active.map((r) => r.code)) : [];
    return {
      maxParticipantsLimit: ownerMaximum,
      rooms: records.map((r) => ({
        ...publicRoom(r),
        participantCount: isActive(r)
          ? live.find((l) => l.name === r.code)?.numParticipants || 0
          : 0,
      })),
    };
  });
  app.get("/api/admin/stats", async (req) => {
    await globalAdmin(req);
    return {
      total_users: await prisma.user.count(),
      active_rooms: await prisma.room.count({ where: { isActive: true } }),
    };
  });
  app.get("/api/admin/room/:code/participants", async (req) => {
    const { r } = await admin(req, req.params.code);
    return {
      participants: (await lk.listParticipants(r.code)).map((p) => ({
        identity: p.identity,
        name: p.name,
        canPublish: p.permission?.canPublish !== false,
        muted: !(p.tracks || []).some(
          (t) => t.source === TrackSource.MICROPHONE && !t.muted,
        ),
      })),
    };
  });
  app.put("/api/admin/room/:code/limit", async (req) => {
    const { u, r } = await admin(req, req.params.code, true),
      limit = Number(req.body?.maxParticipants),
      ceiling = u.id === owner ? ownerMaximum : maximum;
    if (!Number.isInteger(limit) || limit < 2 || limit > ceiling)
      throw fail(400, "Лимит участников: от 2 до " + ceiling);
    const connected = isActive(r) ? await lk.listParticipants(r.code) : [];
    if (isActive(r)) await ensureMediaRoom(r, limit, connected);
    await prisma.$transaction(async (tx) => {
      await tx.roomParticipantName.updateMany({
        where: { roomId: r.id },
        data: { overLimitAllowed: false },
      });
      if (limit < connected.length)
        await tx.roomParticipantName.updateMany({
          where: {
            roomId: r.id,
            identity: { in: connected.map((p) => p.identity) },
          },
          data: { overLimitAllowed: true },
        });
      await tx.room.update({
        where: { id: r.id },
        data: { maxParticipants: limit },
      });
    });
    return {
      success: true,
      maxParticipants: limit,
      participantCount: connected.length,
    };
  });
  app.get("/api/room/:code/names", async (req) => {
    const { r } = await member(req, req.params.code),
      names = await prisma.roomParticipantName.findMany({
        where: { roomId: r.id },
      });
    return {
      names: Object.fromEntries(names.map((n) => [n.identity, n.displayName])),
    };
  });
  app.post("/api/room/:code/name", async (req) => {
    const { r, identity } = await member(req, req.params.code),
      name = String(req.body?.displayName || "")
        .trim()
        .slice(0, 30);
    if (!name) throw fail(400, "Введите имя");
    if (req.body?.identity && req.body.identity !== identity)
      throw fail(403, "Можно менять только своё имя");
    await lk.updateParticipant(r.code, identity, { name });
    await prisma.roomParticipantName.update({
      where: { roomId_identity: { roomId: r.id, identity } },
      data: { displayName: name },
    });
    return { success: true };
  });
  app.post("/api/room/:code/upload", async (req) => {
    const { r, identity } = await member(req, req.params.code),
      part = await req.file();
    if (!part) throw fail(400, "Выберите файл");
    const storage = randomUUID() + ".bin",
      path = join(uploads, storage);
    try {
      await pipeline(part.file, createWriteStream(path));
      if (part.file.truncated) throw fail(413, "Файл больше 10 МБ");
      const size = (await stat(path)).size;
      const f = await prisma.fileUpload.create({
        data: {
          roomId: r.id,
          identity,
          fileName: "encrypted.bin",
          fileType: "application/octet-stream",
          fileSize: size,
          storagePath: storage,
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      return {
        fileId: f.id,
        url: "/api/files/" + f.id,
        expiresAt: f.expiresAt,
      };
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
  });
  app.get("/api/files/:id", async (req, reply) => {
    const f = await prisma.fileUpload.findUnique({
      where: { id: Number(req.params.id) || 0 },
    });
    if (!f || f.expiresAt < new Date()) throw fail(410, "Файл уже удалён");
    const r = await prisma.room.findUnique({ where: { id: f.roomId } });
    await member(req, r.code);
    return reply
      .type("application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .send(createReadStream(join(uploads, f.storagePath)));
  });
  async function cleanup() {
    for (const r of await prisma.room.findMany({
      where: {
        isPersistent: false,
        isActive: true,
        expiresAt: { lt: new Date() },
      },
    })) {
      await lk.deleteRoom(r.code).catch(() => {});
      await prisma.room.update({
        where: { id: r.id },
        data: { isActive: false },
      });
    }
    for (const f of await prisma.fileUpload.findMany({
      where: { expiresAt: { lt: new Date() } },
    })) {
      await unlink(join(uploads, f.storagePath)).catch(() => {});
      await prisma.fileUpload.delete({ where: { id: f.id } });
    }
    const cutoff = new Date(Date.now() - 30 * 86400000);
    for (const r of await prisma.room.findMany({
      where: { isPersistent: false, expiresAt: { lt: cutoff } },
    })) {
      for (const f of await prisma.fileUpload.findMany({
        where: { roomId: r.id },
      }))
        await unlink(join(uploads, f.storagePath)).catch(() => {});
      await prisma.$transaction([
        prisma.connection.deleteMany({ where: { roomId: r.id } }),
        prisma.fileUpload.deleteMany({ where: { roomId: r.id } }),
        prisma.roomParticipantName.deleteMany({ where: { roomId: r.id } }),
        prisma.roomBan.deleteMany({ where: { roomId: r.id } }),
        prisma.room.delete({ where: { id: r.id } }),
      ]);
    }
    await prisma.user.deleteMany({
      where: {
        tgId: { not: BigInt(owner) },
        lastSeenAt: { lt: cutoff },
        rooms: { none: {} },
        connections: { none: {} },
      },
    });
  }
  const timer = setInterval(
    () => cleanup().catch(() => app.log.error("Cleanup failed")),
    60000,
  );
  timer.unref();
  const restartTimer = setInterval(
    () =>
      reopenDueRooms().catch(() => app.log.error("Public room restart failed")),
    1000,
  );
  restartTimer.unref();
  app.addHook("onClose", async () => {
    shuttingDown = true;
    clearInterval(timer);
    clearInterval(restartTimer);
    await Promise.allSettled([...restarting.values()]);
    await prisma.$disconnect();
  });
  await prisma.$connect();
  // One-time safety transition: old private invitations had no server admission proof.
  // Current rooms with accessHash survive normal restarts.
  for (const legacy of await prisma.room.findMany({
    where: {
      isPersistent: false,
      isActive: true,
      encrypted: true,
      accessHash: null,
    },
  })) {
    await lk.deleteRoom(legacy.code).catch(() => {});
    await prisma.room.update({
      where: { id: legacy.id },
      data: { isActive: false },
    });
  }
  for (const name of (env.PERSISTENT_ROOMS || "Общая 1|Общая 2|Общая 3")
    .split("|")
    .filter(Boolean))
    await prisma.room.upsert({
      where: { code: name },
      create: {
        code: name,
        name,
        isPersistent: true,
        encrypted: false,
        maxParticipants: maximum,
      },
      update: { encrypted: false },
    });
  await reopenDueRooms();
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await buildApp();
  await app.listen({
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
  });
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => app.close().then(() => process.exit(0)));
}
