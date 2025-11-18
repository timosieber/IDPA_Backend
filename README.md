# IDPA Backend

Backend-Service für das Chatbot-System inkl. Chatbot-CRUD, Sitzungs- und Nachrichtenverwaltung, Wissensbasis (Embeddings) sowie Anbindung an LLM/Vektor-Datenbanken.

## Stack
- Node.js + TypeScript + Express
- Prisma ORM + SQLite (lokal; kann auf Postgres/MySQL umgestellt werden)
- Appwrite (JWT-Verifikation für Dashboard-User)
- OpenAI (LLM & Embeddings, Mock-Fallbacks vorhanden)
- Pinecone (optionale Vektor-DB, Memory-Store als Default)

## Voraussetzungen
- Node.js 20+
- npm 10+

## Quickstart
```bash
npm install
npm run prisma:migrate      # erstellt dev.db
npm run prisma:seed         # optionales Demo-Setup
npm run dev                 # startet Server auf PORT (default 4000)
```

→ Für den kompletten Produktions-Deploy (Appwrite, Apify, Docker, Snippet) siehe `docs/deployment.md`.

## Nützliche Scripts
- `npm run dev` – tsx-watch Dev-Server
- `npm run build && npm start` – Produktion
- `npm run prisma:migrate` – neue Migration ausführen/erstellen
- `npm run prisma:generate` – Prisma Client regenerieren
- `npm run prisma:seed` – Demo-Daten einspielen
- `npm run lint` – Typecheck

## Environment-Variablen
Alle Variablen siehe `.env.example`.

| Variable | Beschreibung |
| --- | --- |
| `PORT` | HTTP-Port (default 4000) |
| `DATABASE_URL` | Prisma Connection String |
| `JWT_SECRET` | Signatur für Widget-Session-Tokens |
| `SESSION_TTL_MINUTES` | Gültigkeit der Widget-Sessions |
| `RATE_LIMIT_PER_MINUTE` | Globale Rate-Limit-Window-Größe |
| `CORS_ALLOWED_ORIGINS` | Kommagetrennte Liste erlaubter Origins für Admin-API |
| `APPWRITE_*` | Appwrite Endpoint/Project/API-Key/Self-Signed Flag |
| `ALLOW_DEBUG_HEADERS` | `true`, um `x-mock-user-id` in Dev zu zulassen |
| `VECTOR_DB_PROVIDER` | `memory` (default) oder `pinecone` |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | Pinecone Konfiguration |
| `OPENAI_API_KEY` | aktiviert echte LLM-/Embedding-Aufrufe |
| `OPENAI_COMPLETIONS_MODEL`, `OPENAI_EMBEDDINGS_MODEL` | Modellnamen |
| `SCRAPER_DIR` | Pfad zum `IDPA-Scraper` Projekt (für Web/PDF-Crawling) |
| `PERPLEXITY_API_KEY` | Optionaler Key für PDF-Extraktion über Perplexity Sonar |
| `SCRAPER_APIFY_ACTOR_ID` | Optional: Aktiviert den Apify Runner (z. B. `timo.sieber~idpa-scraper`) |
| `SCRAPER_APIFY_API_TOKEN` | API-Token für Apify, wird zusammen mit `SCRAPER_APIFY_ACTOR_ID` benötigt |
| `SCRAPER_APIFY_BASE_URL` | Apify API-Basis (default `https://api.apify.com/v2`) |

## API-Überblick
→ vollständige Spezifikation: `docs/openapi.yaml`

```
POST   /api/chatbots                # erstellt Chatbot (auth)
GET    /api/chatbots                # listet eigene Chatbots
GET    /api/chatbots/:id            # Details
PATCH  /api/chatbots/:id            # Update
DELETE /api/chatbots/:id            # Löschen

POST   /api/chat/sessions           # Widget-Session (Domain-Check)
POST   /api/chat/messages           # Chat-Nachricht -> Antwort

GET    /api/knowledge/sources       # Wissensquellen je Chatbot
POST   /api/knowledge/sources/text  # Freitext hinzufügen
POST   /api/knowledge/sources/scrape # Webseite crawlen und einfügen
DELETE /api/knowledge/sources/:id   # Quelle löschen
```

### Auth
- Dashboard-Endpoints (`/api/chatbots`, `/api/knowledge`) verlangen gültiges Appwrite-JWT im `Authorization: Bearer <token>` Header.
- Öffentliche Widget-Endpoints erstellen/prüfen Sessions via signierte Tokens. Missbrauch wird serverseitig per IP-Limitierung (5 Requests/Minute) gebremst – es ist keine Domain-Whitelist mehr nötig.

### Wissensbasis & Retrieval
- Textquellen werden in Chunks zerteilt, eingebettet und (optional) in Pinecone gespeichert.
- Ohne Pinecone-Config greift ein in-memory Vector Store (nur für Dev geeignet).
- Der integrierte Scraper nutzt das separate Projekt [`IDPA-Scraper`](../IDPA-Scraper) eins zu eins (inkl. Playwright/Readability, PDF.js und optional Perplexity Sonar). Ergebnisdatensätze werden nach dem Lauf gechunkt und direkt in die Vektor-Datenbank übernommen.
- Vor Nutzung bitte im `IDPA-Scraper`-Ordner einmal `npm install` und optional `npm run build` ausführen; `SCRAPER_DIR` muss auf diesen Pfad zeigen.
- Alternativ lässt sich derselbe Actor auf Apify hosten. Sobald `SCRAPER_APIFY_ACTOR_ID` + `SCRAPER_APIFY_API_TOKEN` gesetzt sind, wird automatisch der Apify-Runner verwendet und die lokale Node-Integration entfällt.

## Entwicklungstipps
- `.env.example` kopieren → `.env` und Werte setzen.
- Mit `ALLOW_DEBUG_HEADERS=true` kann in lokalen Tests via `x-mock-user-id` ein Dashboard-User simuliert werden.
- Widget-Endpoints (`/api/chat/*`) drosseln automatisch auf 5 Requests pro Minute und IP. Damit reicht das Einbinden des Snippets – kein Origin-Header oder Domain-Whitelist erforderlich.
- Für Produktionsbetrieb Datenbank + Pinecone/OpenAI konfigurieren und `VECTOR_DB_PROVIDER=pinecone` setzen.
- Für Railway-Deployments:
  1. `Dockerfile` und `.dockerignore` sind bereits vorbereitet.
  2. Neues Railway-Projekt erstellen → „Deploy from GitHub“ → Repo verbinden.
  3. In den Railway-Settings die notwendigen Env-Variablen setzen (`DATABASE_URL`, `JWT_SECRET`, `SCRAPER_DIR`, etc.). Für SQLite sollte auf Railway eine externe DB (z. B. Postgres) verwendet werden.
  4. Build command: `npm run build` (über Docker automatisch) – Start command: `node dist/index.js`.
  5. Optional: separaten Service für den `IDPA-Scraper` auf Railway deployen oder auf Apify hosten. Für Apify einfach den Actor + Token via `SCRAPER_APIFY_*` setzen, andernfalls weiterhin `SCRAPER_DIR` konfigurieren.
