import { useState } from "react";
import { Send, ArrowLeft } from "lucide-react";
import { MemberActions, RoomControls, type BanEntry } from "./RoomManagement";
import { RoomView, Avatar, type Person } from "./RoomView";
export default function CallPreview() {
  const [mic, setMic] = useState(true),
    [panel, setPanel] = useState<"chat" | "people" | null>(() =>
      window.matchMedia("(min-width: 741px)").matches ? "chat" : null,
    ),
    [text, setText] = useState(""),
    [notice, setNotice] = useState("");
  const [messages, setMessages] = useState([
    { name: "Даша", text: "Всем привет! Как прошёл день?", self: false },
    { name: "Андрей", text: "Привет! Сейчас расскажу :)", self: true },
  ]);
  const [locked, setLocked] = useState(false),
    [bans, setBans] = useState<BanEntry[]>([]),
    [removed, setRemoved] = useState<string[]>([]),
    [blocked, setBlocked] = useState<string[]>([]),
    [closed, setClosed] = useState(false);
  const allPeople: Person[] = [
    {
      id: "1",
      name: "Даша",
      speaking: !blocked.includes("1"),
      muted: blocked.includes("1"),
    },
    {
      id: "2",
      name: "Андрей",
      local: true,
      muted: !mic,
      role: "Создатель комнаты",
    },
    { id: "3", name: "Макар", muted: true },
    { id: "4", name: "Вероника", muted: true },
  ];
  const people = allPeople.filter((p) => !removed.includes(p.id));
  function notify(s: string) {
    setNotice(s);
  }
  if (closed)
    return (
      <main className="preview-closed">
        <h1>Комната закрыта</h1>
        <p>Так выглядит завершение разговора для всех участников.</p>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Вернуться к примеру
        </button>
        <a href="/">На главную</a>
      </main>
    );
  return (
    <RoomView
      title="Вечерний разговор"
      subtitle={`Участников: ${people.length} · голосовая комната`}
      encrypted
      people={people}
      mic={mic}
      sharing={false}
      panel={panel}
      onPanel={setPanel}
      onMic={() => setMic(!mic)}
      onShare={() => notify("В примере демонстрация экрана отключена")}
      onLeave={() => location.assign("/")}
      onInvite={() =>
        notify(
          "Это пример. Создайте комнату на главной, чтобы пригласить друзей.",
        )
      }
      preview
      notice={notice}
    >
      {panel === "people" ? (
        <div className="sidebar-content">
          <p className="sidebar-description">
            Вы создатель комнаты. Действия в примере видны только вам.
          </p>
          <ul className="member-list">
            {people.map((p) => (
              <li key={p.id}>
                <Avatar person={p} />
                <div>
                  <b>
                    {p.name}
                    {p.local && " · вы"}
                  </b>
                  <small>
                    {p.speaking
                      ? "Говорит"
                      : p.muted
                        ? "Микрофон выключен"
                        : "В разговоре"}
                  </small>
                </div>
                {!p.local && (
                  <MemberActions
                    name={p.name}
                    blocked={blocked.includes(p.id)}
                    onMute={() => {
                      setBlocked(
                        blocked.includes(p.id)
                          ? blocked.filter((id) => id !== p.id)
                          : [...blocked, p.id],
                      );
                      notify(
                        blocked.includes(p.id)
                          ? "Микрофон разрешён. Участник включает его сам."
                          : "Микрофон запрещён в этой комнате",
                      );
                    }}
                    onKick={() => {
                      setRemoved([...removed, p.id]);
                      notify(
                        "Участник удалён из примера. Это действие не блокирует вход по приглашению.",
                      );
                    }}
                    onBan={() => {
                      setRemoved([...removed, p.id]);
                      setBans([...bans, { identity: p.id, name: p.name }]);
                      notify("Вход участника в эту комнату заблокирован");
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
          <RoomControls
            state={{
              isLocked: locked,
              bans,
              members: people.map((p) => ({
                identity: p.id,
                microphoneBlocked: blocked.includes(p.id),
              })),
            }}
            onLock={() => {
              setLocked(!locked);
              notify(
                locked
                  ? "Вход по приглашению открыт"
                  : "Вход новых участников закрыт",
              );
            }}
            onUnban={(id) => {
              setBans(bans.filter((b) => b.identity !== id));
              notify("Вход участника снова разрешён");
            }}
            onClose={() => {
              if (confirm("Завершить пример разговора для всех?"))
                setClosed(true);
            }}
          />
          <button
            className="text-link reset-preview"
            onClick={() => {
              setRemoved([]);
              setBans([]);
              setBlocked([]);
              setLocked(false);
              setNotice("");
            }}
          >
            Сбросить действия в примере
          </button>
          <a className="text-link" href="/">
            <ArrowLeft size={16} />
            На главную
          </a>
        </div>
      ) : (
        <>
          <p className="sidebar-description">
            Сообщения доступны во время разговора.
          </p>
          <div className="chat-messages" aria-live="polite">
            <span className="chat-date">Пример переписки</span>
            {messages.map((m, i) => (
              <article
                className={`chat-bubble ${m.self ? "self" : ""}`}
                key={i}
              >
                <b>{m.name}</b>
                <p>{m.text}</p>
              </article>
            ))}
            <p className="chat-system">
              Здесь можно попробовать отправить сообщение. Его увидите только
              вы.
            </p>
          </div>
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              setMessages([
                ...messages,
                { name: "Андрей", text: text.trim(), self: true },
              ]);
              setText("");
            }}
          >
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
              disabled={!text.trim()}
            >
              <Send size={20} />
            </button>
          </form>
        </>
      )}
    </RoomView>
  );
}
