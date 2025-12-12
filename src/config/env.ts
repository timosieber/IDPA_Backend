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
  OPENAI_COMPLETIONS_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  RAG_ENABLE_QUERY_REWRITE: booleanString.default(true),
  RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.35),
  SCRAPER_DIR: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  SCRAPER_APIFY_ACTOR_ID: z.string().optional(),
  SCRAPER_APIFY_API_TOKEN: z.string().optional(),
  SCRAPER_APIFY_BASE_URL: z.string().default("https://api.apify.com/v2"),
  // Apify run options (override actor defaults). Helps prevent 60s run timeouts.
  SCRAPER_APIFY_RUN_TIMEOUT_SECS: z.coerce.number().int().min(60).max(6 * 60 * 60).default(3600),
  SCRAPER_APIFY_RUN_MEMORY_MBYTES: z.coerce.number().int().min(128).max(32768).default(2048),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
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
};

export const isProduction = env.NODE_ENV === "production";
