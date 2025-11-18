# End-to-End Deployment Guide

Use this checklist to take the backend online and connect it with Apify, Appwrite, and the public widget endpoints.

## 1. Provision External Services
- **Database**: Postgres/MySQL/SQLite (dev). For production pick Postgres (Railway, Supabase, Neon, …).
- **Appwrite**: Host on Appwrite Cloud or self-host. Create a project for the dashboard, enable email/password (or OAuth) login, record the endpoint, project ID, and API key.
- **Apify (optional)**: If you prefer the hosted scraper, keep the actor ID (`timo.sieber~idpa-scraper`) and copy your API token from Apify → Account → Integrations.

## 2. Configure Environment Variables
Create `.env` based on `.env.example` and fill at least:

```
NODE_ENV=production
PORT=4000
DATABASE_URL="postgresql://..."
JWT_SECRET="long-random-secret"
SESSION_TTL_MINUTES=60
RATE_LIMIT_PER_MINUTE=60
ALLOW_DEBUG_HEADERS=false

# Appwrite
APPWRITE_ENDPOINT="https://cloud.appwrite.io/v1"
APPWRITE_PROJECT_ID="..."
APPWRITE_API_KEY="..."

# LLM / Embeddings
OPENAI_API_KEY="sk-..."

# Scraper (choose ONE mode)
SCRAPER_APIFY_ACTOR_ID="timo.sieber~idpa-scraper"
SCRAPER_APIFY_API_TOKEN="apify_api_..."
# or leave the Apify vars empty and set SCRAPER_DIR to the local IDPA-Scraper path
```

Leave `CORS_ALLOWED_ORIGINS` empty if the public widget should be callable from any website. The IP based widget limiter protects `/api/chat/*`.

## 3. Build & Migrate
Install dependencies and generate the Prisma client:

```bash
npm install
npm run prisma:migrate
npm run prisma:generate
```

For a clean production build:

```bash
npm run build
```

## 4. Run the Server
- **Local**: `npm run dev` (hot reload) or `npm start` (uses `dist`).
- **Docker**: `docker build -t idpa-backend .` then `docker run -p 4000:4000 --env-file .env idpa-backend`.
- **Railway/Render/Fly**: point the service at this repo. Build command `npm run build`, start command `node dist/index.js`, attach the `.env` variables through the dashboard.

Ensure the container/network gives Node visibility into the database and Appwrite.

## 5. Verify the Endpoints
1. `GET /healthz` → `{ status: "ok" }`.
2. Authenticate with Appwrite, call `POST /api/chatbots` to create the first bot.
3. Add knowledge sources via `/api/knowledge/sources/...` if desired.
4. Trigger `POST /api/knowledge/sources/scrape` → confirm Apify/local scraper writes datasets.
5. Use the widget endpoints:
   - `POST /api/chat/sessions` with `{ chatbotId }`.
   - `POST /api/chat/messages` with `{ sessionId, message }` and the returned bearer token.

## 6. Embed on Any Site
Drop this snippet onto the customer page (replace `BACKEND_URL` and `CHATBOT_ID`):

```html
<script>
  (async () => {
    const chatbotId = "YOUR_CHATBOT_ID";
    const backend = "https://BACKEND_URL";
    const sessionRes = await fetch(`${backend}/api/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatbotId })
    });
    const session = await sessionRes.json();

    const messageRes = await fetch(`${backend}/api/chat/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ sessionId: session.sessionId, message: "Hallo 👋" }),
    });
    console.log(await messageRes.json());
  })();
</script>
```

Replace the inline script with the real widget once it is built (`embed.js`). Thanks to the widget IP limiter, no extra domain configuration is required.

## 7. Production Checklist
- [ ] Monitoring/alerting (Railway metrics, Apify run notifications).
- [ ] Regular `npm run prisma:migrate deploy` on deploys.
- [ ] Rotate `JWT_SECRET` periodically.
- [ ] Back up the database and Apify datasets.

With these steps completed, the backend is ready for an end-to-end deployment.
