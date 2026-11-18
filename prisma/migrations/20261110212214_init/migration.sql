-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "pathKey" TEXT NOT NULL,
    "pathVerified" BOOLEAN NOT NULL DEFAULT false,
    "pathExists" BOOLEAN NOT NULL DEFAULT false,
    "isGitRepo" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "techStack" TEXT,
    "gitState" TEXT,
    "gitCheckedAt" DATETIME,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "firstActivityAt" DATETIME,
    "lastActivityAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT,
    "cwd" TEXT,
    "worktree" TEXT,
    "gitBranch" TEXT,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "models" TEXT,
    "primaryModel" TEXT,
    "agentVersion" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "parentExternalId" TEXT,
    "subagentId" TEXT,
    "endState" TEXT NOT NULL DEFAULT 'unknown',
    "endStateDetail" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "userMessageCount" INTEGER NOT NULL DEFAULT 0,
    "assistantMessageCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolErrorCount" INTEGER NOT NULL DEFAULT 0,
    "fileOpCount" INTEGER NOT NULL DEFAULT 0,
    "commandCount" INTEGER NOT NULL DEFAULT 0,
    "malformedLines" INTEGER NOT NULL DEFAULT 0,
    "unknownRecordCount" INTEGER NOT NULL DEFAULT 0,
    "firstUserPrompt" TEXT,
    "lastUserPrompt" TEXT,
    "lastAssistantText" TEXT,
    "summary" TEXT,
    "sourcePath" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceSize" INTEGER,
    "sourceMtime" DATETIME,
    "sha256" TEXT,
    "archivePath" TEXT,
    "providerMeta" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "lineNo" INTEGER,
    "blockIndex" INTEGER,
    "kind" TEXT NOT NULL,
    "role" TEXT,
    "rawType" TEXT,
    "subtype" TEXT,
    "timestamp" DATETIME,
    "uuid" TEXT,
    "parentUuid" TEXT,
    "text" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "toolName" TEXT,
    "toolUseId" TEXT,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "isSidechain" BOOLEAN NOT NULL DEFAULT false,
    "isMeta" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "filePath" TEXT,
    "command" TEXT,
    "rawOffset" INTEGER,
    "rawLength" INTEGER,
    "meta" TEXT,
    CONSTRAINT "Event_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileOp" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT,
    "eventSeq" INTEGER,
    "path" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "toolName" TEXT,
    "toolUseId" TEXT,
    "timestamp" DATETIME,
    "succeeded" BOOLEAN,
    "linesAdded" INTEGER,
    "linesRemoved" INTEGER,
    CONSTRAINT "FileOp_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileOp_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "sessionId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "agent" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "aiReportedStatus" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'unverified',
    "evidence" TEXT,
    "relatedFiles" TEXT,
    "dependencies" TEXT,
    "dedupeKey" TEXT,
    "sourceEventSeq" INTEGER,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "model" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KnowledgeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "evidence" TEXT,
    "dedupeKey" TEXT,
    "occurredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KnowledgeItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "log" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AiCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "targetAgent" TEXT NOT NULL,
    "dirPath" TEXT NOT NULL,
    "zipPath" TEXT,
    "manifest" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Handoff_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filePath" TEXT NOT NULL,
    "sizeMb" REAL NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "includesArchives" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_pathKey_key" ON "Project"("pathKey");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sourceKey_key" ON "Session"("sourceKey");

-- CreateIndex
CREATE INDEX "Session_projectId_endedAt_idx" ON "Session"("projectId", "endedAt");

-- CreateIndex
CREATE INDEX "Session_agent_externalId_idx" ON "Session"("agent", "externalId");

-- CreateIndex
CREATE INDEX "Session_endedAt_idx" ON "Session"("endedAt");

-- CreateIndex
CREATE INDEX "Event_sessionId_seq_idx" ON "Event"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "Event_sessionId_kind_idx" ON "Event"("sessionId", "kind");

-- CreateIndex
CREATE INDEX "Event_toolUseId_idx" ON "Event"("toolUseId");

-- CreateIndex
CREATE INDEX "Event_timestamp_idx" ON "Event"("timestamp");

-- CreateIndex
CREATE INDEX "FileOp_projectId_path_idx" ON "FileOp"("projectId", "path");

-- CreateIndex
CREATE INDEX "FileOp_sessionId_idx" ON "FileOp"("sessionId");

-- CreateIndex
CREATE INDEX "FileOp_toolUseId_idx" ON "FileOp"("toolUseId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_dedupeKey_key" ON "Task"("dedupeKey");

-- CreateIndex
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");

-- CreateIndex
CREATE INDEX "Task_sessionId_idx" ON "Task"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDoc_projectId_docType_key" ON "KnowledgeDoc"("projectId", "docType");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeItem_dedupeKey_key" ON "KnowledgeItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "KnowledgeItem_projectId_kind_idx" ON "KnowledgeItem"("projectId", "kind");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");

-- CreateIndex
CREATE INDEX "AiCache_feature_idx" ON "AiCache"("feature");

-- CreateIndex
CREATE INDEX "Handoff_projectId_createdAt_idx" ON "Handoff"("projectId", "createdAt");
