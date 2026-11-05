ALTER TABLE "Room" ADD COLUMN "isLocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RoomParticipantName" ADD COLUMN "microphoneBlocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RoomParticipantName" ADD COLUMN "allowedWhileLocked" BOOLEAN NOT NULL DEFAULT false;
