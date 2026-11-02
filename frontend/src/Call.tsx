import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, RemoteParticipant } from "livekit-client";
import {
  RoomAudioRenderer,
  StartAudio,
  useParticipants,
  useTracks,
  VideoTrack,
  isTrackReference,
} from "@livekit/components-react";
import { api, headers, keyFor, enc, dec, invite } from "./client";
import type { Token, Message } from "./client";
export default function Call({
  room,
  token,
  code,
  onError,
}: {
  room: Room;
  token: Token;
  code: string;
  onError: (s: string) => void;
}) {
  const participants = useParticipants(),
    tracks = useTracks([Track.Source.ScreenShare]),
    own = room.localParticipant;
  const [mic, setMic] = useState(own.isMicrophoneEnabled),
    [sharing, setSharing] = useState(false),
    [messages, setMessages] = useState<Message[]>([]),
    [text, setText] = useState(""),
    [name, setName] = useState(own.name || ""),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  async function action(fn: () => Promise<void>) {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    const receive = (bytes: Uint8Array, p?: RemoteParticipant) => {
      try {
        const d = JSON.parse(new TextDecoder().decode(bytes));
        if (
          d.type === "chat" &&
          typeof d.text === "string" &&
          d.text.length <= 2000
        )
          setMessages((m) => [
            ...m.slice(-99),
            { id: crypto.randomUUID(), name: p?.name || "Гость", text: d.text },
          ]);
        if (
          d.type === "file" &&
          Number.isInteger(d.file?.id) &&
          d.file.id > 0 &&
          typeof d.file?.name === "string" &&
          d.file.name.length <= 150 &&
          typeof d.file?.iv === "string" &&
          /^[\w-]{16}$/.test(d.file.iv)
        )
          setMessages((m) => [
            ...m.slice(-99),
            { id: crypto.randomUUID(), name: p?.name || "Гость", file: d.file },
          ]);
      } catch {}
    };
    const update = () => {
      setMic(own.isMicrophoneEnabled);
      setSharing(own.isScreenShareEnabled);
    };
    room.on(RoomEvent.DataReceived, receive);
    room.on(RoomEvent.LocalTrackPublished, update);
    room.on(RoomEvent.LocalTrackUnpublished, update);
    room.on(RoomEvent.TrackMuted, update);
    room.on(RoomEvent.TrackUnmuted, update);
    return () => {
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.LocalTrackPublished, update);
      room.off(RoomEvent.LocalTrackUnpublished, update);
      room.off(RoomEvent.TrackMuted, update);
      room.off(RoomEvent.TrackUnmuted, update);
    };
  }, [room]);
  async function send() {
    const t = text.trim();
    if (!t) return;
    await own.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "chat", text: t })),
      { reliable: true },
    );
    setMessages((m) => [
      ...m.slice(-99),
      { id: crypto.randomUUID(), name: own.name || "Вы", text: t, self: true },
    ]);
    setText("");
  }
  async function fileKey() {
    return crypto.subtle.importKey(
      "raw",
      dec(keyFor(code)),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024 - 16)
      throw Error("Файл должен быть меньше 10 МБ");
    const iv = crypto.getRandomValues(new Uint8Array(12)),
      encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await fileKey(),
        await file.arrayBuffer(),
      ),
      form = new FormData();
    form.append("file", new Blob([encrypted]), "encrypted.bin");
    const r = await fetch("/api/room/" + encodeURIComponent(code) + "/upload", {
        method: "POST",
        headers: await headers(),
        body: form,
      }),
      d = await r.json();
    if (!r.ok) throw Error(d.error);
    const f = { id: d.fileId, name: file.name.slice(0, 150), iv: enc(iv) };
    await own.publishData(
      new TextEncoder().encode(JSON.stringify({ type: "file", file: f })),
      { reliable: true },
    );
    setMessages((m) => [
      ...m.slice(-99),
      { id: crypto.randomUUID(), name: own.name || "Вы", file: f, self: true },
    ]);
  }
  async function download(f: NonNullable<Message["file"]>) {
    const r = await fetch("/api/files/" + f.id, { headers: await headers() });
    if (!r.ok) throw Error("Файл недоступен: срок хранения — 5 минут");
    const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: dec(f.iv) },
        await fileKey(),
        await r.arrayBuffer(),
      ),
      url = URL.createObjectURL(new Blob([plain])),
      a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return (
    <section className="call">
      <RoomAudioRenderer />
      <StartAudio label="Включить звук" />
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {token.encrypted
              ? "СКВОЗНОЕ ШИФРОВАНИЕ · E2EE"
              : "ПУБЛИЧНАЯ КОМНАТА · TLS"}
          </p>
          <h1 className="call-title">Разговор в комнате</h1>
          <span className="muted">
            {participants.length} участников · {code}
          </span>
        </div>
        <button
          onClick={() =>
            action(async () => {
              await navigator.clipboard.writeText(invite(code));
              setNotice("Приглашение скопировано");
            })
          }
        >
          Пригласить ↗
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <div className="call-tools">
        <button
          className={mic ? "primary" : ""}
          disabled={pending || own.permissions?.canPublish === false}
          onClick={() =>
            action(async () => {
              await own.setMicrophoneEnabled(!own.isMicrophoneEnabled);
              setMic(own.isMicrophoneEnabled);
            })
          }
        >
          {mic ? "Выключить микрофон" : "Включить микрофон"}
        </button>
        <button
          disabled={pending}
          onClick={() =>
            action(async () => {
              if (!navigator.mediaDevices?.getDisplayMedia)
                throw Error(
                  "Демонстрация экрана недоступна в этом браузере. Попробуйте Chrome на компьютере.",
                );
              await own.setScreenShareEnabled(!own.isScreenShareEnabled, {
                audio: true,
              });
              setSharing(own.isScreenShareEnabled);
            })
          }
        >
          {sharing ? "Остановить показ" : "Показать экран"}
        </button>
        <button className="danger" onClick={() => room.disconnect()}>
          Выйти
        </button>
      </div>
      <div className="screens">
        {tracks.filter(isTrackReference).map((t) => (
          <VideoTrack key={t.publication.trackSid} trackRef={t} />
        ))}
      </div>
      <div className="room-grid">
        <div className="panel">
          <h2>Участники</h2>
          <label htmlFor="room-name">Ваше имя в этой комнате</label>
          <div className="input-row">
            <input
              id="room-name"
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              disabled={pending}
              onClick={() =>
                action(async () => {
                  await api("/room/" + encodeURIComponent(code) + "/name", {
                    displayName: name,
                  });
                  setNotice("Имя сохранено для этой комнаты");
                })
              }
            >
              Сохранить
            </button>
          </div>
          <ul className="participants">
            {participants.map((p) => (
              <li key={p.identity}>
                <span className={"avatar " + (p.isSpeaking ? "speaking" : "")}>
                  {Array.from(p.name || "Г")[0]}
                </span>
                <div>
                  <b>{p.name || "Гость"}</b>
                  {p.metadata?.includes("service_owner") && (
                    <small className="role-label">Владелец сервиса</small>
                  )}
                  {p.metadata?.includes("room_owner") && (
                    <small className="role-label">Создатель комнаты</small>
                  )}
                  <small>
                    {p.isLocal ? "Вы · " : ""}
                    {p.isMicrophoneEnabled
                      ? "Микрофон включён"
                      : "Микрофон выключен"}
                  </small>
                </div>
                {token.isAdmin && !p.isLocal && (
                  <div className="moderation">
                    <button
                      disabled={pending}
                      onClick={() =>
                        action(async () => {
                          await api(
                            "/room/" + encodeURIComponent(code) + "/mute",
                            {
                              targetIdentity: p.identity,
                              muted: p.permissions?.canPublish !== false,
                            },
                          );
                          setNotice(
                            "Права микрофона обновлены. Участник включает его самостоятельно.",
                          );
                        })
                      }
                    >
                      {p.permissions?.canPublish === false
                        ? "Разрешить"
                        : "Запретить микрофон и экран"}
                    </button>
                    <button
                      disabled={pending}
                      className="danger"
                      onClick={() =>
                        action(async () => {
                          await api(
                            "/room/" + encodeURIComponent(code) + "/kick",
                            { targetIdentity: p.identity },
                          );
                          setNotice("Участник удалён");
                        })
                      }
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {token.isAdmin && (
            <button
              className="danger"
              onClick={() => {
                if (confirm("Завершить разговор для всех участников?"))
                  action(async () => {
                    await api(
                      "/room/" + encodeURIComponent(code) + "/close",
                      {},
                    );
                    await room.disconnect();
                  });
              }}
            >
              Закрыть комнату для всех
            </button>
          )}
        </div>
        <div className="panel chat">
          <h2>Чат комнаты</h2>
          <p className="muted small">
            Сообщения доступны только во время разговора. Файлы удаляются через
            5 минут.
          </p>
          <div className="messages" aria-live="polite">
            {messages.length ? (
              messages.map((m) => (
                <div className={"message " + (m.self ? "self" : "")} key={m.id}>
                  <small>{m.name}</small>
                  {m.text ? (
                    <p>{m.text}</p>
                  ) : (
                    <button onClick={() => action(() => download(m.file!))}>
                      Скачать {m.file?.name}
                    </button>
                  )}
                </div>
              ))
            ) : (
              <p className="muted">Здесь пока тихо. Напишите первым.</p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(send);
            }}
          >
            <input
              aria-label="Сообщение"
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              placeholder="Написать сообщение…"
            />
            <button disabled={pending || !text.trim()}>Отправить</button>
          </form>
          {token.encrypted && (
            <>
              <input
                ref={fileInput}
                type="file"
                hidden
                onChange={(e) => {
                  action(() => upload(e.target.files?.[0]));
                  e.target.value = "";
                }}
              />
              <button
                disabled={pending}
                onClick={() => fileInput.current?.click()}
              >
                Прикрепить зашифрованный файл
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
