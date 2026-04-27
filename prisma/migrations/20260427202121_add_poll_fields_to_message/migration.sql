-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "pollChoices" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pollSelectableCount" INTEGER;
