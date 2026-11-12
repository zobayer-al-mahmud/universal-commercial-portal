-- CreateTable
CREATE TABLE "AuthEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "role" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL DEFAULT 'error',
    "source" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "stack" TEXT NOT NULL DEFAULT '',
    "context" TEXT NOT NULL DEFAULT '{}',
    "fingerprint" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT NOT NULL DEFAULT ''
);

-- CreateIndex
CREATE INDEX "AuthEvent_createdAt_idx" ON "AuthEvent"("createdAt");
CREATE INDEX "AuthEvent_username_idx" ON "AuthEvent"("username");
CREATE INDEX "AuthEvent_kind_idx" ON "AuthEvent"("kind");
CREATE INDEX "AuthEvent_userId_idx" ON "AuthEvent"("userId");

-- CreateIndex
CREATE INDEX "ErrorEvent_lastSeen_idx" ON "ErrorEvent"("lastSeen");
CREATE INDEX "ErrorEvent_level_idx" ON "ErrorEvent"("level");
CREATE INDEX "ErrorEvent_source_idx" ON "ErrorEvent"("source");
CREATE INDEX "ErrorEvent_fingerprint_idx" ON "ErrorEvent"("fingerprint");
CREATE INDEX "ErrorEvent_resolvedAt_idx" ON "ErrorEvent"("resolvedAt");
