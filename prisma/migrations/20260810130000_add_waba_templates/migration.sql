-- CreateTable
CREATE TABLE "WabaTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WabaTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WabaTemplate_tenantId_wabaId_name_language_key" ON "WabaTemplate"("tenantId", "wabaId", "name", "language");

-- CreateIndex
CREATE INDEX "WabaTemplate_tenantId_status_idx" ON "WabaTemplate"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "WabaTemplate" ADD CONSTRAINT "WabaTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
