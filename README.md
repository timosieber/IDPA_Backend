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
- Öffentliche Widget-Endpoints erstellen/prüfen Sessions via signierte Tokens; Domains müssen im Chatbot erlaubt sein.

### Wissensbasis & Retrieval
- Textquellen werden in Chunks zerteilt, eingebettet und (optional) in Pinecone gespeichert.
- Ohne Pinecone-Config greift ein in-memory Vector Store (nur für Dev geeignet).
- Der integrierte Scraper nutzt das separate Projekt [`IDPA-Scraper`](../IDPA-Scraper) eins zu eins (inkl. Playwright/Readability, PDF.js und optional Perplexity Sonar). Ergebnisdatensätze werden nach dem Lauf gechunkt und direkt in die Vektor-Datenbank übernommen.
- Vor Nutzung bitte im `IDPA-Scraper`-Ordner einmal `npm install` und optional `npm run build` ausführen; `SCRAPER_DIR` muss auf diesen Pfad zeigen.

## Entwicklungstipps
- `.env.example` kopieren → `.env` und Werte setzen.
- Mit `ALLOW_DEBUG_HEADERS=true` kann in lokalen Tests via `x-mock-user-id` ein Dashboard-User simuliert werden.
- `POST /api/chat/sessions` muss mit korrektem `Origin`-Header aufgerufen werden (entspricht erlaubter Domain).
- Für Produktionsbetrieb Datenbank + Pinecone/OpenAI konfigurieren und `VECTOR_DB_PROVIDER=pinecone` setzen.
