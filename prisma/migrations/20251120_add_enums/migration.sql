-- CreateEnum (only if not exists)
DO $$ BEGIN
 CREATE TYPE "ChatbotStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if not exists)
DO $$ BEGIN
 CREATE TYPE "MessageRole" AS ENUM ('system', 'user', 'assistant');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if not exists)
DO $$ BEGIN
 CREATE TYPE "KnowledgeSourceType" AS ENUM ('URL', 'TEXT', 'FILE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- CreateEnum (only if not exists)
DO $$ BEGIN
 CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('PENDING', 'READY', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- AlterTable Chatbot - Change status column from TEXT to ChatbotStatus
-- Step 1: Drop default
ALTER TABLE "Chatbot" ALTER COLUMN "status" DROP DEFAULT;
-- Step 2: Change type
ALTER TABLE "Chatbot" ALTER COLUMN "status" TYPE "ChatbotStatus" USING ("status"::text::"ChatbotStatus");
-- Step 3: Set new default
ALTER TABLE "Chatbot" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"ChatbotStatus";

-- AlterTable Message - Change role column from TEXT to MessageRole (no default to worry about)
ALTER TABLE "Message" ALTER COLUMN "role" TYPE "MessageRole" USING ("role"::text::"MessageRole");

-- AlterTable KnowledgeSource - Change type column (no default)
ALTER TABLE "KnowledgeSource" ALTER COLUMN "type" TYPE "KnowledgeSourceType" USING ("type"::text::"KnowledgeSourceType");

-- AlterTable KnowledgeSource - Change status column with default
-- Step 1: Drop default
ALTER TABLE "KnowledgeSource" ALTER COLUMN "status" DROP DEFAULT;
-- Step 2: Change type
ALTER TABLE "KnowledgeSource" ALTER COLUMN "status" TYPE "KnowledgeSourceStatus" USING ("status"::text::"KnowledgeSourceStatus");
-- Step 3: Set new default
ALTER TABLE "KnowledgeSource" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"KnowledgeSourceStatus";
