import {
  Ban,
  Ellipsis,
  LockKeyhole,
  LockKeyholeOpen,
  MicOff,
  Mic,
  UserMinus,
} from "lucide-react";
export type BanEntry = { identity: string; name: string };
export type ModerationState = {
  isLocked: boolean;
  bans: BanEntry[];
  members: { identity: string; microphoneBlocked: boolean }[];
};
export function MemberActions({
  name,
  blocked,
  pending,
  onMute,
  onKick,
  onBan,
}: {
  name: string;
  blocked: boolean;
  pending?: boolean;
  onMute: () => void;
  onKick: () => void;
  onBan: () => void;
}) {
  return (
    <details className="member-actions">
      <summary aria-label={`Действия: ${name}`}>
        <Ellipsis size={20} />
      </summary>
      <div className="member-action-menu">
        <button
          disabled={pending}
          onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            onMute();
          }}
        >
          {blocked ? <Mic size={16} /> : <MicOff size={16} />}
          <span>{blocked ? "Разрешить микрофон" : "Запретить микрофон"}</span>
        </button>
        <button
          disabled={pending}
          onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            onKick();
          }}
        >
          <UserMinus size={16} />
          <span>Удалить из звонка</span>
        </button>
        <button
          className="danger"
          disabled={pending}
          onClick={(e) => {
            e.currentTarget.closest("details")?.removeAttribute("open");
            onBan();
          }}
        >
          <Ban size={16} />
          <span>Заблокировать вход</span>
        </button>
      </div>
    </details>
  );
}
export function RoomControls({
  state,
  pending,
  onLock,
  onUnban,
  onClose,
}: {
  state: ModerationState;
  pending?: boolean;
  onLock: () => void;
  onUnban: (identity: string) => void;
  onClose: () => void;
}) {
  return (
    <section className="room-controls">
      <h3>Управление комнатой</h3>
      <button
        className="room-lock"
        role="switch"
        aria-checked={state.isLocked}
        onClick={onLock}
        disabled={pending}
      >
        {state.isLocked ? (
          <LockKeyhole size={20} />
        ) : (
          <LockKeyholeOpen size={20} />
        )}
        <span>
          <b>{state.isLocked ? "Вход закрыт" : "Вход открыт"}</b>
          <small>
            {state.isLocked
              ? "Новые участники не смогут войти"
              : "Можно войти по приглашению"}
          </small>
        </span>
        <span className="switch-track" aria-hidden="true" />
      </button>
      <p className="management-note">
        Текущие участники остаются в разговоре и могут переподключиться.
      </p>
      <details className="bans-list">
        <summary>
          Заблокированные <span>{state.bans.length}</span>
        </summary>
        {state.bans.length ? (
          <ul>
            {state.bans.map((b) => (
              <li key={b.identity}>
                <span>{b.name}</span>
                <button disabled={pending} onClick={() => onUnban(b.identity)}>
                  Разблокировать
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="management-note">
            В этой комнате никто не заблокирован.
          </p>
        )}
      </details>
      <button
        className="close-room danger"
        disabled={pending}
        onClick={onClose}
      >
        Закрыть комнату для всех
      </button>
      <p className="management-note">
        Разговор завершится. Приглашение перестанет действовать.
      </p>
    </section>
  );
}
