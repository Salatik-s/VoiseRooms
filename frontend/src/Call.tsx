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
import {
  MemberActions,
  RoomControls,
  type ModerationState,
} from "./RoomManagement";
import { friendlyError, readResponse, type ErrorContext } from "./errors";
import { RoomView, Avatar } from "./RoomView";
import { Paperclip, Send } from "lucide-react";
import {
  api,
  headers,
  keyFor,
  enc,
  dec,
  invite,
  nativeCallState,
} from "./client";
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
  const [panel, setPanel] = useState<"chat" | "people" | null>(null);
  const [moderation, setModeration] = useState<ModerationState | null>(null);
  const micAllowed = () =>
    own.permissions?.canPublish !== false &&
    (!own.permissions?.canPublishSources.length ||
      own.permissions.canPublishSources.includes(
        Track.sourceToProto(Track.Source.Microphone),
      ));
  const [canUseMic, setCanUseMic] = useState(micAllowed);
  async function refreshModeration() {
    setModeration(
      await api("/room/" + encodeURIComponent(code) + "/moderation"),
    );
  }
  useEffect(() => {
    if (!token.isAdmin || panel !== "people") return;
    let active = true;
    const refresh = () =>
      api("/room/" + encodeURIComponent(code) + "/moderation")
        .then((d) => {
          if (active) setModeration(d);
        })
        .catch((e) => {
          if (active) onError(friendlyError(e));
        });
    void refresh();
    const timer = setInterval(refresh, 6000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [panel, token.isAdmin, code]);
  async function moderate(path: string, body: unknown) {
    await api("/room/" + encodeURIComponent(code) + path, body);
    await refreshModeration();
  }
  const fileInput = useRef<HTMLInputElement>(null);
  async function action(
    fn: () => Promise<void>,
    context: ErrorContext = "general",
  ) {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      onError(friendlyError(e, context));
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
      setCanUseMic(micAllowed());
      nativeCallState(true, own.isMicrophoneEnabled);
      setSharing(own.isScreenShareEnabled);
    };
    nativeCallState(true, own.isMicrophoneEnabled);
    room.on(RoomEvent.DataReceived, receive);
    room.on(RoomEvent.LocalTrackPublished, update);
    room.on(RoomEvent.LocalTrackUnpublished, update);
    room.on(RoomEvent.TrackMuted, update);
    room.on(RoomEvent.TrackUnmuted, update);
    room.on(RoomEvent.ParticipantPermissionsChanged, update);
    return () => {
      nativeCallState(false, false);
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.LocalTrackPublished, update);
      room.off(RoomEvent.LocalTrackUnpublished, update);
      room.off(RoomEvent.TrackMuted, update);
      room.off(RoomEvent.TrackUnmuted, update);
      room.off(RoomEvent.ParticipantPermissionsChanged, update);
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
      d = await readResponse(r);
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
    if (r.status === 410)
      throw Error(
        "Файл уже удалён. Он доступен только 5 минут. Попросите отправить его заново.",
      );
    if (!r.ok) await readResponse(r);
    const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: dec(f.iv) },
        await fileKey(),
        await r.arrayBuffer(),
      ),
      url = URL.createObjectURL(new Blob([plain])),
      a = document.createElement("a");
    if (window.VoiceRoomsNative?.saveFile) {
      URL.revokeObjectURL(url);
      const bytes = new Uint8Array(plain);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      window.VoiceRoomsNative.saveFile(
        f.name,
        btoa(binary),
        "application/octet-stream",
      );
      return;
    }
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return (
    <>
      <RoomAudioRenderer />
      <StartAudio label="Включить звук" />
      <RoomView
        title="Разговор в комнате"
        subtitle={`${participants.length} в комнате · ${code}`}
        encrypted={token.encrypted}
        people={participants.map((p) => ({
          id: p.identity,
          name: p.name || "Гость",
          local: p.isLocal,
          owner: p.metadata?.includes("service_owner"),
          speaking: p.isSpeaking,
          muted: !p.isMicrophoneEnabled,
          role: p.metadata?.includes("service_owner")
            ? "Владелец сервиса"
            : p.metadata?.includes("room_owner")
              ? "Создатель комнаты"
              : undefined,
        }))}
        mic={mic}
        sharing={sharing}
        pending={pending}
        panel={panel}
        onPanel={setPanel}
        notice={notice}
        canUseMic={canUseMic}
        canShare={own.permissions?.canPublish !== false}
        onMic={() =>
          action(async () => {
            await own.setMicrophoneEnabled(!own.isMicrophoneEnabled);
            setMic(own.isMicrophoneEnabled);
          }, "microphone")
        }
        onShare={() =>
          action(async () => {
            if (!navigator.mediaDevices?.getDisplayMedia)
              throw Error(
                "Демонстрация экрана недоступна. Откройте комнату в Chrome на компьютере.",
              );
            await own.setScreenShareEnabled(!own.isScreenShareEnabled, {
              audio: true,
            });
            setSharing(own.isScreenShareEnabled);
          }, "screen")
        }
        onLeave={() => {
          void room.disconnect();
        }}
        onInvite={() =>
          action(async () => {
            await navigator.clipboard.writeText(invite(code));
            setNotice("Приглашение скопировано");
          }, "clipboard")
        }
        media={
          <div className="screens">
            {tracks.filter(isTrackReference).map((t) => (
              <VideoTrack key={t.publication.trackSid} trackRef={t} />
            ))}
          </div>
        }
      >
        {panel === "people" ? (
          <div className="sidebar-content call-management">
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
                  <Avatar
                    person={{
                      id: p.identity,
                      name: p.name || "Гость",
                      speaking: p.isSpeaking,
                      owner: p.metadata?.includes("service_owner"),
                    }}
                  />
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
                  {token.isAdmin &&
                    !p.isLocal &&
                    !p.metadata?.includes("room_owner") &&
                    !p.metadata?.includes("service_owner") &&
                    moderation && (
                      <MemberActions
                        name={p.name || "Гость"}
                        blocked={
                          moderation.members.find(
                            (m) => m.identity === p.identity,
                          )?.microphoneBlocked || false
                        }
                        pending={pending}
                        onMute={() =>
                          action(async () => {
                            const muted = !moderation.members.find(
                              (m) => m.identity === p.identity,
                            )?.microphoneBlocked;
                            await moderate("/mute", {
                              targetIdentity: p.identity,
                              muted,
                            });
                            setNotice(
                              muted
                                ? "Микрофон запрещён в этой комнате"
                                : "Микрофон разрешён. Участник включает его сам.",
                            );
                          })
                        }
                        onKick={() =>
                          action(async () => {
                            await moderate("/kick", {
                              targetIdentity: p.identity,
                            });
                            setNotice(
                              "Участник удалён. При открытом входе он сможет вернуться.",
                            );
                          })
                        }
                        onBan={() =>
                          action(async () => {
                            await moderate("/ban", {
                              targetIdentity: p.identity,
                            });
                            setNotice(
                              "Вход участника в эту комнату заблокирован",
                            );
                          })
                        }
                      />
                    )}
                </li>
              ))}
            </ul>
            {token.isAdmin && !moderation && (
              <p className="management-note" role="status">
                Загружаем управление комнатой…
              </p>
            )}
            {token.isAdmin && moderation && (
              <RoomControls
                state={moderation}
                pending={pending}
                onLock={() =>
                  action(async () => {
                    const locked = !moderation.isLocked;
                    await moderate("/lock", { locked });
                    setNotice(
                      locked
                        ? "Вход новых участников закрыт"
                        : "Вход по приглашению открыт",
                    );
                  })
                }
                onUnban={(identity) =>
                  action(async () => {
                    await moderate("/unban", { targetIdentity: identity });
                    setNotice("Участник разблокирован");
                  })
                }
                onCapacity={(n) =>
                  action(async () => {
                    await api(
                      "/admin/room/" + encodeURIComponent(code) + "/limit",
                      { maxParticipants: n },
                      "PUT",
                    );
                    await refreshModeration();
                    setNotice("Количество мест сохранено");
                  })
                }
                onClose={() =>
                  action(async () => {
                    await api(
                      "/room/" + encodeURIComponent(code) + "/close",
                      {},
                    );
                    await room.disconnect();
                  })
                }
              />
            )}
          </div>
        ) : (
          <>
            <p className="sidebar-description">
              Сообщения доступны во время разговора. Файлы удаляются через 5
              минут.
            </p>
            <div className="chat-messages" aria-live="polite">
              {messages.length ? (
                messages.map((m) => (
                  <article
                    className={`chat-bubble ${m.self ? "self" : ""}`}
                    key={m.id}
                  >
                    <b>{m.name}</b>
                    {m.text ? (
                      <p>{m.text}</p>
                    ) : (
                      <button
                        className="text-link"
                        onClick={() => action(() => download(m.file!), "file")}
                      >
                        Скачать {m.file?.name}
                      </button>
                    )}
                  </article>
                ))
              ) : (
                <p className="chat-system">
                  Здесь появятся сообщения участников.
                </p>
              )}
            </div>
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                action(send);
              }}
            >
              {token.encrypted && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    onChange={(e) => {
                      action(() => upload(e.target.files?.[0]), "file");
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Прикрепить зашифрованный файл"
                    disabled={pending}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip size={20} />
                  </button>
                </>
              )}
              <input
                aria-label="Сообщение"
                placeholder="Сообщение…"
                value={text}
                maxLength={2000}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                className="send-button"
                aria-label="Отправить сообщение"
                disabled={pending || !text.trim()}
              >
                <Send size={20} />
              </button>
            </form>
          </>
        )}
      </RoomView>
    </>
  );
}
