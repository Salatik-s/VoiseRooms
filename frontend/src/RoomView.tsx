import { useEffect, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
export type Person = {
  id: string;
  name: string;
  local?: boolean;
  speaking?: boolean;
  muted?: boolean;
  role?: string;
};
export function Avatar({ person }: { person: Person }) {
  const index =
    (((Array.from(person.id).reduce((sum, c) => sum + c.charCodeAt(0), 0) -
      49) %
      5) +
      5) %
    5;
  return (
    <span
      className={`person-avatar tone-${index % 5} ${person.speaking ? "is-speaking" : ""}`}
      aria-hidden="true"
    >
      {person.name
        .split(" ")
        .slice(0, 2)
        .map((n) => Array.from(n)[0])
        .join("")}
    </span>
  );
}
export function RoomView({
  title,
  subtitle,
  encrypted,
  people,
  mic,
  sharing,
  pending,
  panel,
  onPanel,
  onMic,
  onShare,
  onLeave,
  onInvite,
  children,
  media,
  preview = false,
  notice,
  canUseMic = true,
  canShare = true,
}: {
  title: string;
  subtitle: string;
  encrypted: boolean;
  people: Person[];
  mic: boolean;
  sharing: boolean;
  pending?: boolean;
  panel: "chat" | "people" | null;
  onPanel: (value: "chat" | "people" | null) => void;
  onMic: () => void;
  onShare: () => void;
  onLeave: () => void;
  onInvite: () => void;
  children?: ReactNode;
  media?: ReactNode;
  preview?: boolean;
  notice?: string;
  canUseMic?: boolean;
  canShare?: boolean;
}) {
  const [viewportHeight, setViewportHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setViewportHeight(viewport.height);
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  return (
    <section
      className={`voice-room ${panel ? "with-panel" : ""}`}
      style={viewportHeight ? { height: viewportHeight } : undefined}
    >
      <header className="room-topbar">
        <a href="/" className="wordmark">
          <AudioLines size={23} />
          <span>VoiceRooms</span>
        </a>
        <div className="room-top-actions">
          {preview && <span className="preview-tag">Пример звонка</span>}
          <button
            className="invite-button"
            aria-label="Пригласить"
            onClick={onInvite}
          >
            <Plus size={18} />
            <span>Пригласить</span>
          </button>
        </div>
      </header>
      <div className="room-workspace">
        <main className="conversation">
          <div className="conversation-heading">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="voice-stage">
            {media}
            <div className={`people-stage count-${people.length}`}>
              {people.map((p) => (
                <article
                  className={`person-tile ${p.speaking ? "speaking" : ""}`}
                  key={p.id}
                >
                  <div className="avatar-wrap">
                    <Avatar person={p} />
                    <span className={`mic-badge ${p.speaking ? "active" : ""}`}>
                      {p.muted ? (
                        <MicOff size={15} />
                      ) : p.speaking ? (
                        <AudioLines size={17} />
                      ) : (
                        <Mic size={15} />
                      )}
                    </span>
                  </div>
                  <h2>
                    {p.name}
                    {p.local && <span className="you-label"> · вы</span>}
                  </h2>
                  <p className={p.speaking ? "speaking-label" : ""}>
                    {p.speaking
                      ? "Говорит"
                      : p.role ||
                        (p.muted ? "Микрофон выключен" : "В разговоре")}
                  </p>
                </article>
              ))}
            </div>
          </div>
          <div className="room-security">
            <ShieldCheck size={15} />
            <span>
              {preview
                ? "Локальный просмотр · без подключения к звонку"
                : encrypted
                  ? "Разговор защищён сквозным шифрованием"
                  : "Публичная комната · транспортное шифрование"}
            </span>
          </div>
          <footer className="call-dock">
            <div className="dock-group">
              <button
                className={`dock-control mic-control ${mic ? "" : "muted-control"}`}
                aria-label={mic ? "Выключить микрофон" : "Включить микрофон"}
                aria-pressed={mic}
                onClick={onMic}
                disabled={pending || !canUseMic}
              >
                <span className="control-circle">
                  {mic ? <Mic /> : <MicOff />}
                </span>
                <span>{canUseMic ? "Микрофон" : "Запрещён"}</span>
              </button>
              <button
                className={`dock-control share-control ${sharing ? "selected" : ""}`}
                aria-label={sharing ? "Остановить показ" : "Показать экран"}
                aria-pressed={sharing}
                onClick={onShare}
                disabled={pending || !canShare}
              >
                <span className="control-circle">
                  <MonitorUp />
                </span>
                <span>Экран</span>
              </button>
            </div>
            <button className="dock-control leave-control" onClick={onLeave}>
              <span className="control-circle">
                <PhoneOff />
              </span>
              <span>Выйти</span>
            </button>
            <div className="dock-group">
              <button
                className={`dock-control people-control ${panel === "people" ? "selected" : ""}`}
                onClick={() => onPanel(panel === "people" ? null : "people")}
                aria-expanded={panel === "people"}
              >
                <span className="control-circle">
                  <Users />
                </span>
                <span>
                  Участники <span className="count-label">{people.length}</span>
                </span>
              </button>
              <button
                className={`dock-control chat-control ${panel === "chat" ? "selected" : ""}`}
                onClick={() => onPanel(panel === "chat" ? null : "chat")}
                aria-expanded={panel === "chat"}
              >
                <span className="control-circle">
                  <MessageCircle />
                </span>
                <span>Чат</span>
              </button>
            </div>
          </footer>
        </main>
        {panel && (
          <button
            className="mobile-panel-backdrop"
            aria-label="Вернуться к разговору"
            onClick={() => onPanel(null)}
          />
        )}
        {panel && (
          <aside className="room-sidebar">
            <header className="sidebar-heading">
              <h2>{panel === "chat" ? "Чат комнаты" : "Участники"}</h2>
              <button
                className="icon-button"
                onClick={() => onPanel(null)}
                aria-label="Закрыть панель"
              >
                <X size={20} />
              </button>
            </header>
            {children}
          </aside>
        )}
      </div>
      {notice && (
        <p className="toast" role="status">
          <Check size={17} />
          {notice}
        </p>
      )}
    </section>
  );
}
