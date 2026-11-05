import { useEffect, useState } from "react";
import {
  AudioLines,
  ArrowLeft,
  RefreshCw,
  Users,
  LockKeyhole,
  Globe,
  ArrowUpRight,
  Check,
} from "lucide-react";
import {
  api,
  keyFor,
  clearSession,
  tg,
  type Info,
  type Viewer,
} from "./client";
import { friendlyError } from "./errors";
import { RestartCountdown } from "./RestartCountdown";
export default function ManageRooms({
  viewer,
  loading,
  onSelect,
}: {
  viewer: Viewer | null;
  loading: boolean;
  onSelect: (code: string, key?: string) => void;
}) {
  const [rooms, setRooms] = useState<Info[]>([]),
    [filter, setFilter] = useState<"public" | "private">("public"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState<string | null>(null),
    [closing, setClosing] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  async function refresh() {
    const d = await api("/admin/rooms");
    setRooms(d.rooms || []);
    setLoaded(true);
  }
  useEffect(() => {
    if (!viewer?.isServiceOwner) return;
    let active = true;
    const load = () =>
      api("/admin/rooms")
        .then((d) => {
          if (active) {
            setRooms(d.rooms || []);
            setLoaded(true);
          }
        })
        .catch((e) => {
          if (active) setError(friendlyError(e));
        });
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [viewer?.isServiceOwner]);
  async function action(code: string, fn: () => Promise<void>) {
    setPending(code);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPending(null);
    }
  }
  const visible = rooms.filter((r) =>
    filter === "public" ? r.isPersistent : !r.isPersistent,
  );
  return (
    <div className="manage-page">
      <header className="lobby-topbar">
        <a className="wordmark" href="/">
          <AudioLines size={23} />
          VoiceRooms
        </a>
        <a className="telegram-link" href="/">
          <ArrowLeft size={17} />К комнатам
        </a>
      </header>
      <main className="manage-content">
        <div className="manage-heading">
          <h1>Управление комнатами</h1>
          <p>Места, доступ и перезапуск разговоров.</p>
          {viewer?.isServiceOwner && !tg?.initData && (
            <button
              className="text-link manage-signout"
              onClick={() => {
                clearSession();
                location.assign("/");
              }}
            >
              Выйти из управления
            </button>
          )}
        </div>
        {loading ? (
          <p className="management-note" role="status">
            Проверяем доступ…
          </p>
        ) : viewer === null ? (
          <div className="manage-denied">
            <h2>Не удалось проверить доступ</h2>
            <p>Проверьте подключение к интернету и обновите страницу.</p>
            <button
              className="btn btn-primary"
              onClick={() => location.reload()}
            >
              Обновить страницу
            </button>
            <a href="/">Вернуться к комнатам</a>
          </div>
        ) : !viewer.isServiceOwner ? (
          <div className="manage-denied">
            <LockKeyhole size={28} />
            <h2>Управление недоступно</h2>
            <p>Эта страница доступна владельцу сервиса.</p>
            <a className="btn btn-primary" href="/">
              Вернуться к комнатам
            </a>
          </div>
        ) : (
          <>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="inline-success" role="status">
                <Check size={17} />
                {notice}
              </p>
            )}
            <div className="manage-toolbar">
              <div className="room-filter" role="group" aria-label="Тип комнат">
                <button
                  aria-pressed={filter === "public"}
                  onClick={() => {
                    setFilter("public");
                    setNotice("");
                    setError("");
                  }}
                >
                  <Globe size={16} />
                  Публичные
                </button>
                <button
                  aria-pressed={filter === "private"}
                  onClick={() => {
                    setFilter("private");
                    setNotice("");
                    setError("");
                  }}
                >
                  <LockKeyhole size={16} />
                  Приватные
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="Обновить список комнат"
                disabled={!!pending}
                onClick={() => action("refresh", async () => {})}
              >
                <RefreshCw size={19} />
              </button>
            </div>
            {!loaded ? (
              <p className="management-note" role="status">
                Загружаем комнаты…
              </p>
            ) : !visible.length ? (
              <p className="manage-empty">
                {filter === "public"
                  ? "Публичные комнаты пока не созданы."
                  : "Сейчас нет активных приватных комнат."}
              </p>
            ) : (
              <div className="managed-room-list">
                {visible.map((r) => (
                  <ManagedRoom
                    key={r.code}
                    room={r}
                    max={viewer.maxParticipantsLimit || 100}
                    pending={!!pending}
                    confirming={closing === r.code}
                    onConfirmClose={() => setClosing(r.code)}
                    onCancel={() => setClosing(null)}
                    onLimit={(n) =>
                      action(r.code, async () => {
                        await api(
                          "/admin/room/" +
                            encodeURIComponent(r.code) +
                            "/limit",
                          { maxParticipants: n },
                          "PUT",
                        );
                        setNotice("Количество мест сохранено");
                      })
                    }
                    onClose={() =>
                      action(r.code, async () => {
                        await api(
                          "/admin/room/" +
                            encodeURIComponent(r.code) +
                            "/close",
                          {},
                        );
                        setClosing(null);
                        setNotice(
                          r.isPersistent
                            ? "Разговор завершён. Публичная комната откроется через 5 минут."
                            : "Комната закрыта для всех",
                        );
                      })
                    }
                    onJoin={(key) => onSelect(r.code, key)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
function ManagedRoom({
  room: r,
  max,
  pending,
  confirming,
  onConfirmClose,
  onCancel,
  onLimit,
  onClose,
  onJoin,
}: {
  room: Info;
  max: number;
  pending: boolean;
  confirming: boolean;
  onConfirmClose: () => void;
  onCancel: () => void;
  onLimit: (n: number) => void;
  onClose: () => void;
  onJoin: (key?: string) => void;
}) {
  const [limit, setLimit] = useState(String(r.maxParticipants || 8)),
    [link, setLink] = useState(""),
    [showInvite, setShowInvite] = useState(false),
    [validation, setValidation] = useState("");
  useEffect(
    () => setLimit(String(r.maxParticipants || 8)),
    [r.maxParticipants],
  );
  const inactive = r.isActive === false;
  function joinPrivate() {
    try {
      const u = new URL(link.trim()),
        key = new URLSearchParams(u.hash.slice(1)).get("key") || "";
      if (u.searchParams.get("room") !== r.code || !/^[-\w]{43}$/.test(key))
        throw Error();
      setValidation("");
      onJoin(key);
    } catch {
      setValidation("Вставьте полную ссылку-приглашение именно в эту комнату.");
    }
  }
  return (
    <article className="managed-room">
      <header>
        <div>
          <h2>{r.name}</h2>
          <p
            className={
              inactive ? "managed-room-state restarting" : "managed-room-state"
            }
          >
            {inactive ? (
              <RestartCountdown until={r.reopensAt} />
            ) : (
              <>
                <span className="room-dot" />
                {r.isLocked
                  ? "Вход новых участников закрыт"
                  : "Комната открыта"}
              </>
            )}
          </p>
        </div>
        <span
          className="managed-room-count"
          aria-label={`Участников: ${r.participantCount || 0}`}
        >
          <Users size={17} />
          {r.participantCount || 0}
        </span>
      </header>
      <form
        noValidate
        className="room-limit-form"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(limit);
          if (!Number.isInteger(n) || n < 2 || n > max) {
            setValidation(`Укажите число от 2 до ${max}.`);
            return;
          }
          setValidation("");
          onLimit(n);
        }}
      >
        <label htmlFor={"limit-" + encodeURIComponent(r.code)}>
          Количество мест
        </label>
        <div className="room-limit-input">
          <input
            id={"limit-" + encodeURIComponent(r.code)}
            type="number"
            inputMode="numeric"
            min={2}
            max={max}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={pending}
          />
          <button
            type="submit"
            disabled={pending || Number(limit) === r.maxParticipants}
          >
            Сохранить
          </button>
        </div>
        <p className="management-note">
          Участники останутся в разговоре. Новые входы зависят от свободных
          мест.
        </p>
      </form>
      {validation && (
        <p className="inline-error" role="alert">
          {validation}
        </p>
      )}
      <div className="managed-room-actions">
        <button
          className="managed-join"
          disabled={pending || inactive}
          onClick={() => {
            if (!r.encrypted) onJoin();
            else {
              const key = keyFor(r.code);
              if (key) onJoin(key);
              else setShowInvite(!showInvite);
            }
          }}
        >
          <ArrowUpRight size={17} />
          Войти в разговор
        </button>
        <button
          className="danger"
          disabled={pending || inactive}
          onClick={onConfirmClose}
        >
          {r.isPersistent ? "Перезапустить" : "Закрыть комнату"}
        </button>
      </div>
      {showInvite && r.encrypted && (
        <div className="managed-private-invite">
          <label htmlFor={"key-" + encodeURIComponent(r.code)}>
            Приглашение с ключом комнаты
          </label>
          <p className="management-note">
            Для приватного разговора нужна полная ссылка. Ваш вход будет виден
            участникам.
          </p>
          <input
            id={"key-" + encodeURIComponent(r.code)}
            type="url"
            placeholder="https://…/?room=…#key=…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={!link.trim() || pending}
            onClick={joinPrivate}
          >
            Продолжить
          </button>
        </div>
      )}
      {confirming && (
        <div className="close-room-confirm">
          <p>
            {r.isPersistent
              ? "Завершить текущий разговор? Комната откроется через 5 минут."
              : "Закрыть комнату для всех? Приглашение перестанет действовать."}
          </p>
          <div>
            <button className="danger" disabled={pending} onClick={onClose}>
              {r.isPersistent ? "Перезапустить комнату" : "Закрыть для всех"}
            </button>
            <button disabled={pending} onClick={onCancel}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
