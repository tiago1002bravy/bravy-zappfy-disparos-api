-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "groupListIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "GroupList" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupListMembership" (
    "id" TEXT NOT NULL,
    "groupListId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "GroupListMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupList_tenantId_idx" ON "GroupList"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupList_tenantId_name_key" ON "GroupList"("tenantId", "name");

-- CreateIndex
CREATE INDEX "GroupListMembership_groupId_idx" ON "GroupListMembership"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupListMembership_groupListId_groupId_key" ON "GroupListMembership"("groupListId", "groupId");

-- AddForeignKey
ALTER TABLE "GroupList" ADD CONSTRAINT "GroupList_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupListMembership" ADD CONSTRAINT "GroupListMembership_groupListId_fkey" FOREIGN KEY ("groupListId") REFERENCES "GroupList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupListMembership" ADD CONSTRAINT "GroupListMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
