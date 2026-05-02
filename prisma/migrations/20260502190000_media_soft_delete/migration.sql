-- Soft-delete pra MediaAsset. Politica: nunca apagar objetos do MinIO,
-- apenas marcar a media como deletada (oculta do listing).
ALTER TABLE "MediaAsset" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "MediaAsset_tenantId_deletedAt_idx" ON "MediaAsset"("tenantId", "deletedAt");
