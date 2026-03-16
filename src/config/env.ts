import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const booleanString = z
  .union([z.string(), z.boolean()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (!value) return false;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(12).default("dev-secret-change-me"),
  SESSION_TTL_MINUTES: z.coerce.number().default(60),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(60),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  APPWRITE_ENDPOINT: z.string().optional(),
  APPWRITE_PROJECT_ID: z.string().optional(),
  APPWRITE_API_KEY: z.string().optional(),
  APPWRITE_SELF_SIGNED: booleanString.default(false),
  ALLOW_DEBUG_HEADERS: booleanString.default(false),
  VECTOR_DB_PROVIDER: z.enum(["memory", "pinecone"]).default("memory"),
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_COMPLETIONS_MODEL: z.string().default("gpt-5.1"),
  OPENAI_EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDINGS_PROVIDER: z.enum(["openai", "deterministic_test"]).default("openai"),
  RAG_ENABLE_QUERY_REWRITE: booleanString.default(true),
  RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.38),
  RAG_SOFT_RELEVANCE: z.coerce.number().min(0).max(1).default(0.30),
  RAG_DETERMINISTIC_LLM: booleanString.default(true),
  RAG_MIN_HYDRATED_CHUNKS: z.coerce.number().int().min(0).max(50).default(1),
  RAG_MIN_SUPPORTED_CLAIMS: z.coerce.number().int().min(0).max(50).default(1),
  RAG_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1000).max(200_000).default(20_000),
  INGESTION_WORKER_ENABLED: booleanString.default(true),
  INGESTION_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  INGESTION_MAX_VECTOR_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OUTBOX_RUNNING_TTL_MS: z.coerce.number().int().min(1000).max(24 * 60 * 60 * 1000).default(5 * 60 * 1000),
  SCRAPER_DIR: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  SCRAPER_APIFY_ACTOR_ID: z.string().optional(),
  SCRAPER_APIFY_API_TOKEN: z.string().optional(),
  SCRAPER_APIFY_BASE_URL: z.string().default("https://api.apify.com/v2"),
  // Apify run options (override actor defaults). Helps prevent 60s run timeouts.
  SCRAPER_APIFY_RUN_TIMEOUT_SECS: z.coerce.number().int().min(60).max(6 * 60 * 60).default(3600),
  SCRAPER_APIFY_RUN_MEMORY_MBYTES: z.coerce.number().int().min(128).max(32768).default(2048),
  // Firecrawl configuration
  FIRECRAWL_API_KEY: z.string().optional(),
  SCRAPER_PROVIDER: z.enum(["firecrawl", "apify", "local"]).default("local"),
  SCRAPE_SCHEDULE_TZ_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(0),
  // Voice configuration (OpenAI Whisper + TTS)
  OPENAI_TTS_MODEL: z.string().default("tts-1-hd"),
  OPENAI_TTS_VOICE: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).default("nova"),
  OPENAI_WHISPER_MODEL: z.string().default("whisper-1"),
  VOICE_MAX_AUDIO_SIZE_MB: z.coerce.number().default(25),
  VOICE_MAX_RESPONSE_CHARS: z.coerce.number().default(4096),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Hard guarantees for production: no fallbacks allowed.
if (parsed.data.NODE_ENV === "production") {
  if (parsed.data.VECTOR_DB_PROVIDER !== "pinecone") {
    // eslint-disable-next-line no-console
    console.error("❌ Production requires VECTOR_DB_PROVIDER=pinecone (no fallback stores allowed)");
    process.exit(1);
  }
  if (!parsed.data.PINECONE_API_KEY || !parsed.data.PINECONE_INDEX) {
    // eslint-disable-next-line no-console
    console.error("❌ Pinecone not fully configured (PINECONE_API_KEY + PINECONE_INDEX required)");
    process.exit(1);
  }
  if (parsed.data.EMBEDDINGS_PROVIDER !== "openai") {
    // eslint-disable-next-line no-console
    console.error("❌ Production requires EMBEDDINGS_PROVIDER=openai");
    process.exit(1);
  }
  if (!parsed.data.OPENAI_API_KEY) {
    // eslint-disable-next-line no-console
    console.error("❌ Production requires OPENAI_API_KEY (no mock embeddings allowed)");
    process.exit(1);
  }
}

const allowedOrigins = parsed.data.CORS_ALLOWED_ORIGINS
  ? parsed.data.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  : [];
const defaultScraperDir = parsed.data.SCRAPER_DIR ?? path.resolve(process.cwd(), "../IDPA-Scraper");

export const env = {
  ...parsed.data,
  CORS_ALLOWED_ORIGINS_LIST: allowedOrigins,
  SCRAPER_DIR: defaultScraperDir,
  SCRAPER_APIFY_BASE_URL: parsed.data.SCRAPER_APIFY_BASE_URL ?? "https://api.apify.com/v2",
  SCRAPE_SCHEDULE_TZ_OFFSET_MINUTES: parsed.data.SCRAPE_SCHEDULE_TZ_OFFSET_MINUTES ?? 0,
};

export const isProduction = env.NODE_ENV === "production";
