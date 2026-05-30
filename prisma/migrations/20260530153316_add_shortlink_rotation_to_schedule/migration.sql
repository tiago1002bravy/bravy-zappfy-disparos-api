-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "shortlinkPrevCount" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "shortlinkRotationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shortlinkSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[];
