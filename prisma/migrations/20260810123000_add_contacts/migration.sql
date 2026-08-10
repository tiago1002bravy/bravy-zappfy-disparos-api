-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('LEAD', 'BUYER');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "source" TEXT NOT NULL DEFAULT 'hotwebinar',
    "externalRef" TEXT,
    "boughtAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactSyncState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "lastSeenCursor" TIMESTAMP(3),
    "lastFullSyncAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunError" TEXT,
    "lastRunUpserts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ContactSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_phone_key" ON "Contact"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "Contact_tenantId_kind_idx" ON "Contact"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "Contact_tenantId_lastSeenAt_idx" ON "Contact"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactSyncState_tenantId_key" ON "ContactSyncState"("tenantId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactSyncState" ADD CONSTRAINT "ContactSyncState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
