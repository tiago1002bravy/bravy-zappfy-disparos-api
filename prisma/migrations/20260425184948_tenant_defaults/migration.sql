-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "defaultInstanceName" TEXT,
ADD COLUMN     "defaultInstanceTokenEnc" TEXT,
ADD COLUMN     "defaultParticipants" TEXT[] DEFAULT ARRAY[]::TEXT[];
