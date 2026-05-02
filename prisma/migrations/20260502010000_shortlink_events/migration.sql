CREATE TABLE "GroupShortlinkEvent" (
    "id" TEXT NOT NULL,
    "shortlinkId" TEXT NOT NULL,
    "itemId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupShortlinkEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GroupShortlinkEvent_shortlinkId_createdAt_idx" ON "GroupShortlinkEvent"("shortlinkId", "createdAt");
CREATE INDEX "GroupShortlinkEvent_type_createdAt_idx" ON "GroupShortlinkEvent"("type", "createdAt");

ALTER TABLE "GroupShortlinkEvent" ADD CONSTRAINT "GroupShortlinkEvent_shortlinkId_fkey" FOREIGN KEY ("shortlinkId") REFERENCES "GroupShortlink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
