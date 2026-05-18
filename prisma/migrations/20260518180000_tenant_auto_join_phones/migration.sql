-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "autoJoinPhones" TEXT[] DEFAULT ARRAY[]::TEXT[];
