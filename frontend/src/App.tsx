import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  ExternalE2EEKeyProvider,
  isE2EESupported,
} from "livekit-client";
import { RoomContext } from "@livekit/components-react";
import { api, tg, keyFor, enc, invite, admissionProof, digest } from "./client";
import type { Info, Token } from "./client";
import { Icons } from "./Icons";
import { LegalPage, LegalLinks } from "./Legal";
import "./styles.css";
import "./repairs.css";
const Call = lazy(() => import("./Call"));
export default function App() {
  const [code, setCode] = useState(
      new URLSearchParams(location.search).get("room") || "",
    ),
    [input, setInput] = useState(""),
    [info, setInfo] = useState<Info | null>(null),
    [rooms, setRooms] = useState<Info[]>([]),
    [call, setCall] = useState<Room | null>(null),
    [token, setToken] = useState<Token | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [screen, setScreen] = useState("main"),
    [lang, setLang] = useState<"ru" | "en">("ru");
  const en = lang === "en";
  const resource = useRef<{ room: Room; worker?: Worker } | null>(null);
  useEffect(() => {
    tg?.ready();
    tg?.expand();
    fetch("/api/rooms/public")
      .then((r) => r.json())
      .then((d) => setRooms(d.rooms || []))
      .catch(() => setError("Публичные комнаты временно недоступны"));
    return () => {
      resource.current?.room.disconnect();
      resource.current?.worker?.terminate();
    };
  }, []);
  useEffect(() => {
    if (!code) {
      setInfo(null);
      return;
    }
    const k = new URLSearchParams(location.hash.slice(1)).get("key");
    if (k && /^[\w-]{43}$/.test(k)) sessionStorage.setItem("vr-key-" + code, k);
    fetch("/api/room/" + encodeURIComponent(code))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error);
        setInfo(d);
        setScreen("ready");
      })
      .catch((e) => setError(e.message));
  }, [code]);
  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function select(c: string, key = "") {
    if (key) sessionStorage.setItem("vr-key-" + c, key);
    history.replaceState(null, "", invite(c, key));
    setCode(c);
    setInfo(null);
    setStatus("");
  }
  async function create() {
    const key = enc(crypto.getRandomValues(new Uint8Array(32)));
    const d = await api("/room/create", {
      accessHash: await digest(await admissionProof(key)),
    });
    select(d.code, key);
  }
  async function join() {
    if (!info) return;
    const key = keyFor(code);
    if (info.encrypted && (!key || !isE2EESupported()))
      throw Error(
        !key
          ? "Для приватной комнаты нужна полная ссылка-приглашение с ключом."
          : "Браузер не поддерживает сквозное шифрование. Откройте ссылку в актуальном Chrome или Safari.",
      );
    const d: Token = await api("/token", {
      room: code,
      ...(info.encrypted ? { accessProof: await admissionProof(key) } : {}),
    });
    let worker: Worker | undefined;
    const provider = new ExternalE2EEKeyProvider();
    if (d.encrypted) {
      worker = new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url),
        { type: "module" },
      );
      await provider.setKey(key);
    }
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      ...(worker ? { encryption: { keyProvider: provider, worker } } : {}),
    });
    resource.current = { room, worker };
    room.on(RoomEvent.Disconnected, () => {
      setCall(null);
      setStatus(
        "Соединение завершено. Можно войти повторно, если комната открыта.",
      );
      worker?.terminate();
    });
    room.on(RoomEvent.EncryptionError, (e) =>
      setError("Ошибка шифрования: " + e.message),
    );
    try {
      if (worker) await room.setE2EEEnabled(true);
      await room.connect(d.livekitUrl, d.token);
      await room.startAudio();
      setToken(d);
      setCall(room);
      setStatus("");
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch {
        setError(
          "Микрофон не разрешён. Вы в комнате: разрешите доступ или слушайте без микрофона.",
        );
      }
    } catch (e) {
      await room.disconnect();
      worker?.terminate();
      throw e;
    }
  }
  function openInput() {
    let c = input.trim(),
      key = "";
    try {
      const u = new URL(c);
      c = u.searchParams.get("room") || "";
      key = new URLSearchParams(u.hash.slice(1)).get("key") || "";
    } catch {}
    if (!c) throw Error("Вставьте приглашение или код публичной комнаты");
    select(c, key);
  }
  if (["/privacy", "/terms"].includes(location.pathname)) return <LegalPage />;
  return (
    <>
      <div className="repair-alerts">
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              aria-label="Закрыть уведомление"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
      </div>
      {call && token ? (
        <div className="call-container">
          <RoomContext.Provider value={call}>
            <Suspense fallback={<p>Открываем комнату…</p>}>
              <Call room={call} token={token} code={code} onError={setError} />
            </Suspense>
          </RoomContext.Provider>
        </div>
      ) : (
        <div className="landing">
          {screen === "main" ? (
            <>
              <div className="landing-top">
                <div className="landing-logo">
                  <div className="logo-icon">
                    <Icons.Mic />
                  </div>
                  <h1>VoiceRooms</h1>
                  <p className="landing-subtitle">
                    {en
                      ? "Voice rooms by invitation"
                      : "Голосовые комнаты по приглашению"}
                  </p>
                </div>
                <div className="landing-top-actions">
                  <button
                    className="lang-toggle"
                    onClick={() => setLang(en ? "ru" : "en")}
                  >
                    <Icons.Globe />
                    <span>{en ? "RU" : "EN"}</span>
                  </button>
                </div>
              </div>
              <div className="landing-body">
                <button
                  className="action-card"
                  onClick={() => run(create)}
                  disabled={busy}
                >
                  <div className="action-icon create">
                    <Icons.Plus />
                  </div>
                  <div className="action-text">
                    <span className="action-title">
                      {en ? "Create a room" : "Создать комнату"}
                    </span>
                    <span className="action-desc">
                      {en
                        ? "Private conversation with end-to-end encryption"
                        : "Приватный разговор со сквозным шифрованием"}
                    </span>
                  </div>
                </button>
                <button
                  className="action-card"
                  onClick={() => setScreen("join")}
                  disabled={busy}
                >
                  <div className="action-icon join">
                    <Icons.Key />
                  </div>
                  <div className="action-text">
                    <span className="action-title">
                      {en ? "Join a room" : "Присоединиться"}
                    </span>
                    <span className="action-desc">
                      {en
                        ? "Paste your invitation link"
                        : "Вставьте ссылку-приглашение"}
                    </span>
                  </div>
                </button>
                <div className="public-rooms">
                  <h3 className="section-title">
                    <Icons.Users />
                    {en ? "Public rooms" : "Публичные комнаты"}
                  </h3>
                  {rooms.map((r) => (
                    <button
                      className="room-card"
                      key={r.code}
                      onClick={() => select(r.code)}
                      disabled={busy}
                    >
                      <span className="room-dot" />
                      <span className="room-name">{r.name}</span>
                      <span className="room-count">
                        {r.participantCount || 0}
                      </span>
                      <span className="room-arrow">→</span>
                    </button>
                  ))}
                  <p className="hint-text public-note">
                    {en
                      ? "Public rooms use transport encryption, without E2EE."
                      : "Публичные комнаты защищены транспортным шифрованием, без E2EE."}
                  </p>
                </div>
                <a
                  className="inline-tip"
                  href="https://t.me/vidagram_bot"
                  target="_blank"
                  rel="noreferrer"
                >
                  {en ? "In any Telegram chat:" : "В любом чате Telegram:"}{" "}
                  <b>@vidagram_bot</b>
                  <br />
                  <small>
                    {en
                      ? "Send the suggested invitation — the room is ready."
                      : "Отправьте предложенное приглашение — комната готова."}
                  </small>
                </a>
              </div>
            </>
          ) : (
            <>
              <div className="landing-header">
                <button
                  className="back-btn"
                  aria-label="Назад"
                  onClick={() => {
                    setScreen("main");
                    setError("");
                  }}
                >
                  <Icons.ArrowLeft />
                </button>
                <h1>
                  {screen === "join"
                    ? en
                      ? "Join a room"
                      : "Присоединиться"
                    : en
                      ? "Room is ready"
                      : "Комната готова"}
                </h1>
              </div>
              <div className="landing-body">
                {screen === "join" ? (
                  <>
                    <label className="input-label" htmlFor="invite">
                      {en
                        ? "Invitation link or public room code"
                        : "Приглашение или код публичной комнаты"}
                    </label>
                    <input
                      id="invite"
                      className="landing-input"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && run(async () => openInput())
                      }
                      placeholder="https://…/?room=…#key=…"
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy || !input.trim()}
                      onClick={() => run(async () => openInput())}
                    >
                      {en ? "Continue" : "Продолжить"}
                    </button>
                  </>
                ) : (
                  info && (
                    <>
                      <div className="profile-card">
                        <Icons.Shield />
                        <h2>{info.name}</h2>
                        <p className="hint-text">
                          {info.encrypted
                            ? en
                              ? "Private room · E2EE"
                              : "Приватная комната · E2EE"
                            : en
                              ? "Public room · no E2EE"
                              : "Публичная комната · без E2EE"}
                        </p>
                        <p className="hint-text">
                          {en
                            ? "Allow microphone access after joining, or listen without it."
                            : "После входа разрешите микрофон или слушайте без него."}
                        </p>
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => run(join)}
                        >
                          {busy
                            ? en
                              ? "Connecting…"
                              : "Подключаемся…"
                            : en
                              ? "Join conversation"
                              : "Войти в разговор"}
                        </button>
                        {info.encrypted && keyFor(code) && (
                          <button
                            className="btn copy-invite"
                            onClick={() =>
                              run(async () => {
                                await navigator.clipboard.writeText(
                                  invite(code),
                                );
                                setStatus(
                                  en
                                    ? "Invitation copied"
                                    : "Приглашение скопировано",
                                );
                              })
                            }
                          >
                            {en ? "Copy invitation" : "Скопировать приглашение"}
                          </button>
                        )}
                      </div>
                      <p className="hint-text">
                        {en
                          ? "The invitation contains the encryption key. Share it only with participants."
                          : "Приглашение содержит ключ шифрования. Передавайте его только участникам."}
                      </p>
                    </>
                  )
                )}
                {status && (
                  <p role="status" className="hint-text">
                    {status}
                  </p>
                )}
              </div>
            </>
          )}
          <div className="landing-footer">
            <Icons.Shield />
            <span>
              {en
                ? "E2EE in private rooms"
                : "Сквозное шифрование в приватных комнатах"}
            </span>
          </div>
          <LegalLinks />
        </div>
      )}
    </>
  );
}
