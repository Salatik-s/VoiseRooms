# Room lifecycle and capacity

The server decides the service-owner role from verified Telegram data or its signed paired session. `/api/me` reports the role and configured capacity ceiling; client flags do not grant permissions. Service owners may moderate every room, but an encrypted room still requires its invitation key.

Persistent public rooms use `reopensAt` as a durable deadline. Closing one marks it inactive immediately and deletes its current media room. It remains visible in the public list while closed. After 300,000 milliseconds it is eligible to reopen; a one-second worker, metadata requests and startup all process due deadlines. A stopped or unavailable server cannot reopen a room until service resumes. Reopening creates a new media room and clears the admission lock. Explicit participant bans and microphone restrictions remain until changed by a manager. Private-room closure has no reopening deadline.

Each room's database `maxParticipants` is its admission limit. The media room uses the configured service-owner ceiling as a hard cap so a manager can change the admission limit during an ongoing call. A reduction does not remove connected participants. New token requests are rejected when all places are occupied; signed join webhooks also check stale tokens and concurrent arrivals. Participants present when the limit is lowered are allowed to continue until they leave.

Legacy deployed media rooms can retain an older, smaller immutable hard cap. If a requested increase exceeds that hard cap while the call has participants, the API returns a Russian explanation instead of interrupting the call. Once it is empty the media room can be upgraded automatically. Existing custom admission limits are preserved across server restarts.

The ordinary creator ceiling comes from `MAX_ROOM_PARTICIPANTS` (default 8). The service-owner ceiling comes from `MAX_OWNER_ROOM_PARTICIPANTS` (default 100, at least the creator ceiling, at most 100). These are configuration limits, not a measured 100-person load capacity.

Verification: `node --test backend/test/security.test.js backend/test/moderation.test.js` covers 13 tests. `backend/test/integration.mjs` additionally completes 39 checks against an isolated PostgreSQL database and actual LiveKit APIs. Those checks do not establish physical-device audio or 100-person performance.
