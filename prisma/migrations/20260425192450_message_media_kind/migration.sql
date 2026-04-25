-- CreateEnum
CREATE TYPE "MessageMediaKind" AS ENUM ('AUTO', 'IMAGE', 'VIDEO', 'AUDIO', 'PTT', 'DOCUMENT');

-- AlterTable
ALTER TABLE "MessageMedia" ADD COLUMN     "kind" "MessageMediaKind" NOT NULL DEFAULT 'AUTO';
