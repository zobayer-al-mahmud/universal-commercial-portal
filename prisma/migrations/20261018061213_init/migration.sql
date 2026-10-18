-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "roleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    PRIMARY KEY ("roleId", "permissionId"),
    CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Module" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeDetected" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "SourceDocument_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "businessKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leasedBy" TEXT,
    "leaseExpiresAt" DATETIME,
    "lastError" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JobStageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobStageEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PoExtractionRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sl" INTEGER NOT NULL,
    "dateOfOrder" TEXT,
    "orderNo" TEXT NOT NULL,
    "productNo" TEXT,
    "productName" TEXT,
    "productDescription" TEXT,
    "season" TEXT,
    "customsCustomerGroup" TEXT,
    "typeOfConstruction" TEXT,
    "noOfPieces" INTEGER,
    "invoiceAveragePrice" REAL,
    "currency" TEXT,
    "timeOfDelivery" TEXT,
    "planningMarketA" TEXT,
    "planningMarketB" TEXT,
    "quantity" INTEGER,
    "termsOfDelivery" TEXT,
    "transportBy" TEXT,
    "source" TEXT,
    "message" TEXT NOT NULL DEFAULT '',
    "success" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PoExtractionRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesContractRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "blockContractRef" TEXT NOT NULL,
    "commercialContRef" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "orderNo" TEXT NOT NULL,
    "styleNo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "orderQty" INTEGER NOT NULL,
    "totalQtyWithPackSet" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "value" REAL NOT NULL,
    "timeOfDelivery" TEXT NOT NULL,
    "packSet" INTEGER NOT NULL DEFAULT 1,
    "remarks" TEXT NOT NULL DEFAULT '',
    "supersedesRowId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesContractRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReviewTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "contextJson" TEXT NOT NULL DEFAULT '{}',
    "assignedToId" TEXT,
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReviewTicket_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReferenceData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "metaJson" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IntegrationAdapter" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'mock',
    "status" TEXT NOT NULL DEFAULT 'not_configured',
    "lastCheckedAt" DATETIME,
    "message" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_roleId_idx" ON "User"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_sha256_key" ON "SourceDocument"("sha256");

-- CreateIndex
CREATE INDEX "SourceDocument_jobId_idx" ON "SourceDocument"("jobId");

-- CreateIndex
CREATE INDEX "SourceDocument_sha256_idx" ON "SourceDocument"("sha256");

-- CreateIndex
CREATE INDEX "Job_module_status_idx" ON "Job"("module", "status");

-- CreateIndex
CREATE INDEX "Job_businessKey_idx" ON "Job"("businessKey");

-- CreateIndex
CREATE INDEX "JobStageEvent_jobId_idx" ON "JobStageEvent"("jobId");

-- CreateIndex
CREATE INDEX "PoExtractionRow_jobId_idx" ON "PoExtractionRow"("jobId");

-- CreateIndex
CREATE INDEX "PoExtractionRow_orderNo_idx" ON "PoExtractionRow"("orderNo");

-- CreateIndex
CREATE INDEX "SalesContractRow_jobId_idx" ON "SalesContractRow"("jobId");

-- CreateIndex
CREATE INDEX "SalesContractRow_orderNo_idx" ON "SalesContractRow"("orderNo");

-- CreateIndex
CREATE INDEX "SalesContractRow_blockContractRef_idx" ON "SalesContractRow"("blockContractRef");

-- CreateIndex
CREATE INDEX "ReviewTicket_module_status_idx" ON "ReviewTicket"("module", "status");

-- CreateIndex
CREATE INDEX "ReviewTicket_jobId_idx" ON "ReviewTicket"("jobId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ReferenceData_type_idx" ON "ReferenceData"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceData_type_code_key" ON "ReferenceData"("type", "code");
