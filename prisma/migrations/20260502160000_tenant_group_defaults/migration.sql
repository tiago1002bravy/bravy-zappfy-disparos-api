-- Defaults de grupo no nível tenant (admins, desc, foto, locked/announce)
ALTER TABLE "Tenant"
  ADD COLUMN "defaultGroupAdmins"          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "defaultGroupDescription"     TEXT,
  ADD COLUMN "defaultGroupPictureMediaId"  TEXT,
  ADD COLUMN "defaultGroupLocked"          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "defaultGroupAnnounce"        BOOLEAN NOT NULL DEFAULT true;
