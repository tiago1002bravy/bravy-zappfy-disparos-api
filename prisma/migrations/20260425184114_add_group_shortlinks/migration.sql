-- CreateTable
CREATE TABLE "GroupShortlink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currentInviteUrl" TEXT,
    "lastRefreshedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "lastClickedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupShortlink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupShortlink_slug_key" ON "GroupShortlink"("slug");

-- CreateIndex
CREATE INDEX "GroupShortlink_tenantId_idx" ON "GroupShortlink"("tenantId");

-- CreateIndex
CREATE INDEX "GroupShortlink_groupId_idx" ON "GroupShortlink"("groupId");

-- AddForeignKey
ALTER TABLE "GroupShortlink" ADD CONSTRAINT "GroupShortlink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupShortlink" ADD CONSTRAINT "GroupShortlink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
