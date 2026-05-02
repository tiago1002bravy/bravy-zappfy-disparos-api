-- 1. Enums novos
CREATE TYPE "ShortlinkStrategy" AS ENUM ('SEQUENTIAL', 'ROUND_ROBIN', 'RANDOM');
CREATE TYPE "CapacitySource" AS ENUM ('UAZAPI', 'CLICK_COUNT');
CREATE TYPE "ShortlinkItemStatus" AS ENUM ('ACTIVE', 'FULL', 'INVALID', 'DISABLED');

-- 2. Tabela de items (multi-grupo por shortlink)
CREATE TABLE "GroupShortlinkItem" (
    "id" TEXT NOT NULL,
    "shortlinkId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "ShortlinkItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentInviteUrl" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "lastClickedAt" TIMESTAMP(3),
    "participantsCount" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAtClicks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GroupShortlinkItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupShortlinkItem_shortlinkId_groupId_key" ON "GroupShortlinkItem"("shortlinkId", "groupId");
CREATE INDEX "GroupShortlinkItem_shortlinkId_status_order_idx" ON "GroupShortlinkItem"("shortlinkId", "status", "order");

ALTER TABLE "GroupShortlinkItem" ADD CONSTRAINT "GroupShortlinkItem_shortlinkId_fkey" FOREIGN KEY ("shortlinkId") REFERENCES "GroupShortlink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupShortlinkItem" ADD CONSTRAINT "GroupShortlinkItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Tabela de clicks (tracking por requisicao)
CREATE TABLE "GroupShortlinkClick" (
    "id" TEXT NOT NULL,
    "shortlinkId" TEXT NOT NULL,
    "itemId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "region" TEXT,
    "city" TEXT,
    "geoResolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupShortlinkClick_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GroupShortlinkClick_shortlinkId_createdAt_idx" ON "GroupShortlinkClick"("shortlinkId", "createdAt");
CREATE INDEX "GroupShortlinkClick_geoResolved_createdAt_idx" ON "GroupShortlinkClick"("geoResolved", "createdAt");

ALTER TABLE "GroupShortlinkClick" ADD CONSTRAINT "GroupShortlinkClick_shortlinkId_fkey" FOREIGN KEY ("shortlinkId") REFERENCES "GroupShortlink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Colunas novas no GroupShortlink
ALTER TABLE "GroupShortlink"
  ADD COLUMN "strategy"           "ShortlinkStrategy" NOT NULL DEFAULT 'SEQUENTIAL',
  ADD COLUMN "hardCap"             INTEGER NOT NULL DEFAULT 900,
  ADD COLUMN "initialClickBudget"  INTEGER NOT NULL DEFAULT 800,
  ADD COLUMN "capacitySource"      "CapacitySource" NOT NULL DEFAULT 'UAZAPI',
  ADD COLUMN "autoCreate"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoCreateInstance"  TEXT,
  ADD COLUMN "autoCreateTemplate"  TEXT;

-- 5. Backfill: cada shortlink vira 1 shortlink + 1 item (order=0)
INSERT INTO "GroupShortlinkItem" (
  "id", "shortlinkId", "groupId", "order", "status",
  "currentInviteUrl", "lastRefreshedAt",
  "clicks", "lastClickedAt", "nextCheckAtClicks",
  "createdAt", "updatedAt"
)
SELECT
  -- ID compatível com cuid (24 chars random) — Prisma vai aceitar
  'cm' || substr(md5(random()::text || s.id), 1, 22),
  s."id",
  s."groupId",
  0,
  'ACTIVE',
  s."currentInviteUrl",
  s."lastRefreshedAt",
  s."clicks",
  s."lastClickedAt",
  800,
  s."createdAt",
  s."updatedAt"
FROM "GroupShortlink" s
WHERE s."groupId" IS NOT NULL;

-- 6. Drop colunas legacy do GroupShortlink (depois do backfill)
ALTER TABLE "GroupShortlink" DROP CONSTRAINT IF EXISTS "GroupShortlink_groupId_fkey";
DROP INDEX IF EXISTS "GroupShortlink_groupId_idx";
ALTER TABLE "GroupShortlink"
  DROP COLUMN "groupId",
  DROP COLUMN "currentInviteUrl",
  DROP COLUMN "lastRefreshedAt";
