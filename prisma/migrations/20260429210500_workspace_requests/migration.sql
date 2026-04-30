-- CreateEnum
CREATE TYPE "WorkspaceRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "WorkspaceRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "reason" TEXT,
    "status" "WorkspaceRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByEmail" TEXT,
    "rejectionReason" TEXT,
    "createdTenantId" TEXT,

    CONSTRAINT "WorkspaceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceRequest_status_createdAt_idx" ON "WorkspaceRequest"("status", "createdAt");
