-- ============================================================================
-- PR1+PR2: createdById em GroupShortlink + userId em ApiKey
-- Resolve a divergência entre conn per-tenant (legacy) e per-user.
-- ============================================================================

-- 1) GroupShortlink.createdById
ALTER TABLE "GroupShortlink" ADD COLUMN "createdById" TEXT;
ALTER TABLE "GroupShortlink"
  ADD CONSTRAINT "GroupShortlink_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "GroupShortlink_createdById_idx" ON "GroupShortlink"("createdById");

-- Backfill: para cada shortlink, set createdById = primeiro OWNER do tenant
-- que tenha Conexão WhatsApp configurada. Se nenhum, fica null e o resolver
-- aplica o fallback firstOwnerWithConn no runtime.
UPDATE "GroupShortlink" sl
SET "createdById" = (
  SELECT u."id"
  FROM "User" u
  WHERE u."tenantId" = sl."tenantId"
    AND u."role" = 'OWNER'
    AND u."instanceTokenEnc" IS NOT NULL
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
WHERE sl."createdById" IS NULL;

-- 2) ApiKey.userId
ALTER TABLE "ApiKey" ADD COLUMN "userId" TEXT;
ALTER TABLE "ApiKey"
  ADD CONSTRAINT "ApiKey_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- Backfill: API keys legadas viram do primeiro OWNER do tenant com conn.
-- Mesmo critério do shortlink pra consistência.
UPDATE "ApiKey" k
SET "userId" = (
  SELECT u."id"
  FROM "User" u
  WHERE u."tenantId" = k."tenantId"
    AND u."role" = 'OWNER'
    AND u."instanceTokenEnc" IS NOT NULL
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
WHERE k."userId" IS NULL;

-- 3) Corrigir autoCreateInstance defasado pro shortlink claudecode (instância velha → nova)
-- Heurística: trocar QUALQUER autoCreateInstance que aponte pra instância que
-- não existe mais como User.instanceName em nenhum user do mesmo tenant.
UPDATE "GroupShortlink" sl
SET "autoCreateInstance" = (
  SELECT u."instanceName"
  FROM "User" u
  WHERE u."tenantId" = sl."tenantId"
    AND u."role" = 'OWNER'
    AND u."instanceName" IS NOT NULL
    AND u."instanceTokenEnc" IS NOT NULL
  ORDER BY u."createdAt" ASC
  LIMIT 1
)
WHERE sl."autoCreate" = true
  AND sl."autoCreateInstance" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "User" u2
    WHERE u2."tenantId" = sl."tenantId"
      AND u2."instanceName" = sl."autoCreateInstance"
  );
