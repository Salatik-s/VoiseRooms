ALTER TABLE "Room" ADD COLUMN "reopensAt" TIMESTAMP(3);
ALTER TABLE "RoomParticipantName" ADD COLUMN "overLimitAllowed" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Room_isPersistent_isActive_reopensAt_idx" ON "Room"("isPersistent", "isActive", "reopensAt");
UPDATE "Room" SET "reopensAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "isPersistent" = true AND "isActive" = false;
