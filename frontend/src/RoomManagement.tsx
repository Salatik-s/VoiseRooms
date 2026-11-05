import { useEffect, useState } from "react";
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
  maxParticipants?: number;
  maxAllowedParticipants?: number;
  isPersistent?: boolean;
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
  onCapacity,
}: {
  state: ModerationState;
  pending?: boolean;
  onLock: () => void;
  onUnban: (identity: string) => void;
  onClose: () => void;
  onCapacity?: (limit: number) => void;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  return (
    <section className="room-controls">
      <h3>Управление комнатой</h3>
      {onCapacity && state.maxParticipants !== undefined && (
        <RoomCapacity
          current={state.maxParticipants}
          max={state.maxAllowedParticipants || 100}
          pending={pending}
          onSave={onCapacity}
        />
      )}
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
        onClick={() => setConfirmClose(true)}
      >
        {state.isPersistent
          ? "Перезапустить комнату"
          : "Закрыть комнату для всех"}
      </button>
      {confirmClose && (
        <div className="close-room-confirm">
          <p>
            {state.isPersistent
              ? "Завершить разговор? Публичная комната откроется через 5 минут."
              : "Закрыть комнату для всех? Приглашение перестанет действовать."}
          </p>
          <div>
            <button
              className="danger"
              disabled={pending}
              onClick={() => {
                onClose();
                setConfirmClose(false);
              }}
            >
              {state.isPersistent
                ? "Перезапустить комнату"
                : "Закрыть для всех"}
            </button>
            <button disabled={pending} onClick={() => setConfirmClose(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
      <p className="management-note">
        {state.isPersistent
          ? "Разговор завершится. Публичная комната откроется через 5 минут."
          : "Разговор завершится. Приглашение перестанет действовать."}
      </p>
    </section>
  );
}

function RoomCapacity({
  current,
  max,
  pending,
  onSave,
}: {
  current: number;
  max: number;
  pending?: boolean;
  onSave: (limit: number) => void;
}) {
  const [value, setValue] = useState(String(current)),
    [error, setError] = useState("");
  useEffect(() => setValue(String(current)), [current]);
  return (
    <form
      noValidate
      className="room-limit-form call-limit-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        if (!Number.isInteger(n) || n < 2 || n > max) {
          setError(`Укажите число от 2 до ${max}.`);
          return;
        }
        setError("");
        onSave(n);
      }}
    >
      <label htmlFor="call-capacity">Места в комнате</label>
      <div className="room-limit-input">
        <input
          id="call-capacity"
          type="number"
          min={2}
          max={max}
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
        />
        <button disabled={pending || Number(value) === current}>
          Сохранить
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <p className="management-note">
        Участники останутся в разговоре. Новый лимит применяется к следующим
        входам.
      </p>
    </form>
  );
}
