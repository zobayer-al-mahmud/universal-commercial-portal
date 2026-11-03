-- CreateTable
CREATE TABLE "PortalCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portal" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "secretEnc" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalCredential_portal_key" ON "PortalCredential"("portal");
