-- AlterTable
ALTER TABLE "GroupUpdateSchedule" ADD COLUMN "shortlinkSlugs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "shortlinkPrevCount" INTEGER;
