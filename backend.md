# Backend Implementation Summary

## Stack
- Node.js 22 + TypeScript + Express 5
- Prisma ORM (SQLite local, Postgres-ready for Railway)
- Appwrite SDK for admin auth, JWT + nanoid for widget sessions
- Pino logging, rate limiting, Zod validation
- OpenAI (LLM & embeddings) + Pinecone/Mem vector store
- External `IDPA-Scraper` integration (local Node runner or Apify-hosted actor) for ingesting web/PDF knowledge

## Solution Overview
1. **Project Setup**
   - Strict tsconfig, `tsx` dev runner, lint via `tsc --noEmit`.
   - Multi-stage Dockerfile builds TS + Prisma client, ready for Railway.
   - `.env.example` documents all required variables; Zod schema enforces them at runtime.

2. **Data Model (Prisma)**
   - Tables: `users`, `chatbots`, `sessions`, `messages`, `knowledge_sources`, `embeddings`.
   - Foreign keys + indexes for ownership, session/token lookups.
   - Enums for chatbot status, message roles, knowledge source types/status.

3. **Auth & Middleware**
   - `requireDashboardAuth` verifies Appwrite JWT or mock header (dev only).
   - Rate limiter on `/api` plus detailed HTTP error handler.
   - CORS restricted to allowed origins via env configuration.

4. **Chatbot CRUD (`/api/chatbots`)**
   - Create/list/get/update/delete with domain normalization, theme handling, owner checks.
   - Stored fields: description, allowed domains, theme JSON, model, status.

5. **Widget APIs**
   - `POST /api/chat/sessions`: erstellt Sessions (kein Domain-Whitelist-Erfordernis mehr), IP-Limit 5 Requests/Minute, schreibt hashed Token.
   - `POST /api/chat/messages`: validates token, loads conversation history, retrieves knowledge context, calls LLM, stores assistant reply.

6. **Knowledge Sources**
   - Manual text ingestion (`POST /api/knowledge/sources/text`).
   - Full crawl ingestion via `POST /api/knowledge/sources/scrape`:
     - Spawns the `IDPA-Scraper` actor lokal oder triggert den Apify-Actor (je nach gesetzten `SCRAPER_APIFY_*` Variablen, inkl. optionaler Perplexity-Keys).
     - Reads dataset output (pages + PDFs), chunks text, generates embeddings, stores metadata (headings/lang/http info).
     - Re-ingestion wipes previous embeddings/vectors before writing new ones.
   - List + delete endpoints manage existing sources.

7. **Vector Retrieval**
   - Abstraction layer for memory store (dev) and Pinecone (prod) with metadata-aware similarity search/delete.
   - Embedding service uses OpenAI if key present; otherwise deterministic mock vector.

8. **Logging & Error Handling**
   - Pino logger auto-detects `pino-pretty` in dev; fallback JSON logs in prod to avoid missing dependency issues.
   - Central error handler returns structured JSON for all known `HttpError` subclasses.

9. **Deployment Notes**
   - Docker build installs dev deps to ensure Prisma CLI is available; runtime trims everything else.
   - Railway setup instructions in README: connect repo, set env vars (`DATABASE_URL`, `JWT_SECRET`, etc.), optional remote scraper.
   - Service currently exposed internally via `idpa_backend.railway.internal`.

10. **Documentation & Tracking**
    - README, OpenAPI (`docs/openapi.yaml`), and `todo.md` updated to reflect backend completion.
    - `backend.md` (this file) summarizes architecture for future maintainers.

## Next Steps
- Expose widget/embed assets via CDN and build dashboard/frontend pieces.
- Consider background queue for long-running scrapes instead of blocking HTTP requests.
- Add automated migrations (`prisma migrate deploy`) to deployment pipeline.
- Implement analytics/events table, monitoring/alerting, and privacy review.
