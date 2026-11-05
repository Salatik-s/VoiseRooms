# Local design preview

Worktree: `sukhovskiy.a.a/voicerooms-call-design`, created from `acec0b7`. The original desktop checkout is unchanged. No push or deployment was requested or performed.

The local frontend runs on `http://127.0.0.1:5199/`. The development-only visual example is `/?preview=call`. It shares RoomView, MemberActions and RoomControls with the real client. Its participants, messages and moderation actions are illustrative and do not contact LiveKit.

The isolated API listens on loopback port 3099. Its PostgreSQL database is `voicerooms_test_design_20261105` on loopback port 5433. LiveKit uses ports 7898, 7899 and 7900. Local media configuration and runtime files are under the ignored `.impeccable/runtime/` directory. Production credentials and databases are not used.

## Room behavior

- The authenticated creator owns the room. An invitation carries admission and encryption material, never ownership.
- Microphone restriction persists across token renewal. Restoring permission does not turn a microphone on. Screen sharing remains available.
- Kick removes the current participant. Re-entry is possible when admission is open.
- Ban prevents that identity from entering this room until explicitly removed. The management panel lists bans and provides unban.
- Lock snapshots connected identities. They and the room managers may reconnect; new identities cannot obtain an admission token. Kicking someone also removes their locked-room readmission permission.
- Close ends the room and rejects subsequent admission.
- Signed LiveKit join webhooks re-check bans, locked-room admission and microphone restrictions for older tokens. This is an after-join enforcement mechanism, not an atomic pre-handshake rejection.

A guest browser session can be replaced by opening a new session. It is not a permanent person-level ban. Telegram identities are bound to the verified Telegram account. No new fingerprinting or account requirements were added.

## Verification

- Frontend TypeScript and production build pass; the development preview is excluded from production assets.
- 15 focused automated tests cover authentication, invitation handling, room ownership, cross-room authorization, kick/ban/unban, locks, signed stale-token webhooks and microphone restrictions.
- 31 integration checks pass against actual isolated PostgreSQL and LiveKit, including the new migration and moderation APIs. Error tests cover offline state, microphone permissions, malformed responses, rate limiting, oversized requests and unknown routes.
- UI checks in the built-in browser cover chat, microphone state, participant actions, ban/unban, admission lock and the completed close state. Narrow phone layouts and desktop layouts are checked separately.
- The built-in browser could not establish a localhost media connection, including after a loopback/TCP configuration check. Its user-facing failure is Russian. API tests do not establish two-party microphone, speaker, screen-share or physical-device behavior.

Apply `backend/prisma/migrations/202611050001_room_moderation` before running this version against any other database. This was applied only to the isolated local database.
