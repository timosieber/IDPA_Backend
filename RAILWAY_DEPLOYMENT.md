# 🚂 Railway Deployment Guide - IDPA ChatBot Platform

Dieses Dokument beschreibt Schritt für Schritt, wie du das Frontend und Backend deiner ChatBot-Platform auf Railway deployen kannst.

---

## 📋 Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Architektur-Übersicht](#architektur-übersicht)
3. [Schritt 1: Externe Services einrichten](#schritt-1-externe-services-einrichten)
4. [Schritt 2: Backend auf Railway deployen](#schritt-2-backend-auf-railway-deployen)
5. [Schritt 3: Frontend auf Railway deployen](#schritt-3-frontend-auf-railway-deployen)
6. [Schritt 4: Services verbinden](#schritt-4-services-verbinden)
7. [Schritt 5: Domain konfigurieren](#schritt-5-domain-konfigurieren)
8. [Troubleshooting](#troubleshooting)
9. [Environment-Variablen Referenz](#environment-variablen-referenz)

---

## Voraussetzungen

### Accounts die du benötigst:

- ✅ **Railway Account** - [railway.app](https://railway.app) (kostenloser Starter-Plan verfügbar)
- ✅ **GitHub Account** - Deine Repositories müssen auf GitHub liegen
- ✅ **Appwrite Account** - [cloud.appwrite.io](https://cloud.appwrite.io) (für Authentifizierung)
- ✅ **OpenAI Account** - [platform.openai.com](https://platform.openai.com) (für AI-Features)
- ⚠️ **Pinecone Account** - [pinecone.io](https://pinecone.io) (optional, für Production Vector DB)
- ⚠️ **Apify Account** - [apify.com](https://apify.com) (optional, für Cloud Scraping)

### Was du vorbereiten solltest:

- [ ] Beide GitHub Repositories (Frontend & Backend) sind auf GitHub gepusht
- [ ] Du hast die Repository-URLs bereit
- [ ] Du hast Zugriff auf die Appwrite Console
- [ ] Du hast einen OpenAI API Key erstellt

---

## Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────────┐
│                      RAILWAY PROJEKT                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐         ┌─────────────────────┐     │
│  │   Frontend       │         │     Backend         │     │
│  │   Service        │────────▶│     Service         │     │
│  │  (Port 5173)     │ Proxy   │   (Port 4000)       │     │
│  └──────────────────┘ /api/*  └─────────────────────┘     │
│         │                              │                    │
│         │                              ▼                    │
│         │                      ┌──────────────┐            │
│         │                      │ PostgreSQL   │            │
│         │                      │   Plugin     │            │
│         │                      └──────────────┘            │
│         │                                                   │
│         ▼                                                   │
│  Public Domain                                             │
│  https://your-app.railway.app                              │
└─────────────────────────────────────────────────────────────┘
         │                               │
         │ Auth                          │ AI/Vector
         ▼                               ▼
┌──────────────────┐          ┌──────────────────────┐
│  Appwrite Cloud  │          │  External Services   │
│  Authentication  │          │  - OpenAI API        │
└──────────────────┘          │  - Pinecone DB       │
                              │  - Apify Scraper     │
                              └──────────────────────┘
```

---

## Schritt 1: Externe Services einrichten

### 1.1 Appwrite Project Setup

**Du hast bereits ein Appwrite-Projekt, aber du musst die Platform URLs konfigurieren:**

1. Gehe zu [cloud.appwrite.io/console](https://cloud.appwrite.io/console)
2. Öffne dein Projekt (ID: `6914520c000ee1da7505`)
3. Navigiere zu **Settings** → **Platforms**
4. Füge eine neue **Web App** hinzu:
   - **Name**: IDPA ChatBot Production
   - **Hostname**: `your-frontend-url.railway.app` (kommt später, kannst du aktualisieren)
5. Konfiguriere **OAuth Providers**:
   - Gehe zu **Auth** → **Settings** → **OAuth Providers**
   - **Google OAuth**: Stelle sicher, dass deine Railway-URL in den Redirect-URLs erlaubt ist

**Notiere dir:**
- ✅ Project ID: `6914520c000ee1da7505` (hast du bereits)
- ✅ API Endpoint: `https://fra.cloud.appwrite.io/v1` (hast du bereits)
- ⚠️ **API Key**: Erstelle einen neuen API-Key mit diesen Scopes:
  - `users.read`
  - `users.write`
  - Navigation: **Settings** → **View API Keys** → **Create API Key**

### 1.2 OpenAI API Key erstellen

1. Gehe zu [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Klicke auf **Create new secret key**
3. Name: `IDPA ChatBot Production`
4. Permissions: **All** (oder mindestens Zugriff auf Models & Embeddings)
5. **Kopiere den Key** (Format: `sk-proj-...`) - du siehst ihn nur einmal!

**Budget-Limit setzen (empfohlen):**
- Gehe zu **Settings** → **Limits**
- Setze ein monatliches Budget (z.B. $10-20 für Testing)

### 1.3 Pinecone Setup (Optional, für Production)

**Für erste Tests kannst du `VECTOR_DB_PROVIDER=memory` verwenden. Für Production empfohlen:**

1. Erstelle Account auf [pinecone.io](https://www.pinecone.io/)
2. Erstelle einen neuen **Index**:
   - **Name**: `chatbot-embeddings`
   - **Dimensions**: `1536` (für OpenAI text-embedding-3-small)
   - **Metric**: `cosine`
   - **Cloud**: `AWS` oder `GCP` (je nach Region)
   - **Region**: Wähle eine Region nahe deiner Railway-Instanz
3. Kopiere deinen **API Key** aus dem Dashboard

### 1.4 Apify Actor Setup (Optional, für Cloud Scraping)

**Nur notwendig, wenn du den Cloud-Scraper statt lokalem Scraper nutzen willst:**

1. Gehe zu [apify.com](https://apify.com)
2. Suche nach dem Actor: `timo.sieber~idpa-scraper`
3. Kopiere die **Actor ID**: `timo.sieber~idpa-scraper`
4. Erstelle einen **API Token**:
   - Navigation: **Settings** → **Integrations** → **API tokens**
   - Klicke **Create new token**

---

## Schritt 2: Backend auf Railway deployen

### 2.1 Neues Railway Projekt erstellen

1. Gehe zu [railway.app/new](https://railway.app/new)
2. Wähle **Deploy from GitHub repo**
3. Autorisiere Railway für GitHub (falls noch nicht geschehen)
4. Wähle dein **IDPA_Backend** Repository
5. Railway erkennt automatisch die Konfiguration (`railway.json`)

### 2.2 PostgreSQL Datenbank hinzufügen

1. Klicke im Projekt auf **+ New**
2. Wähle **Database** → **Add PostgreSQL**
3. Railway erstellt automatisch die Datenbank
4. Die `DATABASE_URL` wird automatisch als Environment-Variable gesetzt

### 2.3 Environment-Variablen konfigurieren

Klicke auf dein **Backend Service** → **Variables** → **Raw Editor**

**Kopiere diese Vorlage und füge deine Werte ein:**

```bash
# ==============================================
# SERVER CONFIGURATION
# ==============================================
NODE_ENV=production
PORT=4000

# ==============================================
# DATABASE
# ==============================================
# Wird automatisch von Railway PostgreSQL-Plugin gesetzt - NICHT überschreiben!
# DATABASE_URL wird automatisch hinzugefügt

# ==============================================
# SECURITY & AUTHENTICATION
# ==============================================
# WICHTIG: Generiere einen starken Secret!
# Terminal: openssl rand -base64 32
JWT_SECRET=<GENERIERE-EINEN-STARKEN-SECRET>

SESSION_TTL_MINUTES=60
RATE_LIMIT_PER_MINUTE=60
ALLOW_DEBUG_HEADERS=false

# ==============================================
# CORS CONFIGURATION
# ==============================================
# WICHTIG: Aktualisiere nach Frontend-Deployment!
# Kommagetrennte Liste (keine Leerzeichen!)
CORS_ALLOWED_ORIGINS=https://your-frontend-url.railway.app

# ==============================================
# APPWRITE AUTHENTICATION
# ==============================================
APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=6914520c000ee1da7505
APPWRITE_API_KEY=<DEIN-APPWRITE-API-KEY>
APPWRITE_SELF_SIGNED=false

# ==============================================
# OPENAI / LLM CONFIGURATION
# ==============================================
OPENAI_API_KEY=<DEIN-OPENAI-API-KEY>
OPENAI_COMPLETIONS_MODEL=gpt-4o-mini
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small

# ==============================================
# VECTOR DATABASE
# ==============================================
# Für erste Tests: "memory"
# Für Production: "pinecone"
VECTOR_DB_PROVIDER=memory

# Nur wenn VECTOR_DB_PROVIDER=pinecone:
# PINECONE_API_KEY=<DEIN-PINECONE-API-KEY>
# PINECONE_INDEX=chatbot-embeddings

# ==============================================
# WEB SCRAPING CONFIGURATION
# ==============================================
# Apify Cloud Scraper (empfohlen für Railway)
SCRAPER_APIFY_ACTOR_ID=timo.sieber~idpa-scraper
SCRAPER_APIFY_API_TOKEN=<DEIN-APIFY-TOKEN-OPTIONAL>
SCRAPER_APIFY_BASE_URL=https://api.apify.com/v2

# Optional: Perplexity für PDF-Extraktion
# PERPLEXITY_API_KEY=<DEIN-PERPLEXITY-KEY>
```

**Wichtige Hinweise:**

- ⚠️ **JWT_SECRET generieren:**
  ```bash
  openssl rand -base64 32
  ```
  Kopiere die Ausgabe und setze sie als `JWT_SECRET`

- ⚠️ **CORS_ALLOWED_ORIGINS**: Musst du nach Frontend-Deployment aktualisieren!

### 2.4 Deployment starten

1. Railway startet automatisch das Deployment
2. Überwache die Logs: **Service** → **Deployments** → **View Logs**
3. Warte auf: ✅ `Build successful` → ✅ `Deployment live`

**Erwartete Log-Ausgaben:**
```
✅ Prisma migrations deployed
✅ Server listening on :4000
✅ Health check passed
```

### 2.5 Backend-URL notieren

1. Klicke auf dein **Backend Service** → **Settings**
2. Scrolle zu **Networking**
3. Du siehst zwei URLs:
   - **Public Domain**: z.B. `idpa-backend-production-xxxx.up.railway.app` (❌ nicht verwenden)
   - **Private Network**: z.B. `idpa-backend.railway.internal` (✅ für Frontend-Proxy)

**Notiere dir die Private Network URL:**
```
idpa-backend.railway.internal
```

### 2.6 Health-Check testen

1. Öffne das **Public Domain** in deinem Browser
2. Füge `/healthz` hinzu: `https://idpa-backend-xxx.up.railway.app/healthz`
3. Du solltest sehen:
   ```json
   {
     "status": "ok",
     "timestamp": "2025-11-20T14:30:00.000Z"
   }
   ```

✅ **Backend ist deployed!**

---

## Schritt 3: Frontend auf Railway deployen

### 3.1 Frontend Service hinzufügen

1. Im selben Railway Projekt: Klicke **+ New**
2. Wähle **GitHub Repo**
3. Wähle dein **IDPA_Frontend** Repository
4. Railway erkennt die Konfiguration (`railway.json`)

### 3.2 Environment-Variablen konfigurieren

Klicke auf dein **Frontend Service** → **Variables** → **Raw Editor**

**Kopiere diese Vorlage:**

```bash
# ==============================================
# APPWRITE AUTHENTICATION
# ==============================================
VITE_APPWRITE_PROJECT_ID=6914520c000ee1da7505
VITE_APPWRITE_API_ENDPOINT=https://fra.cloud.appwrite.io/v1

# ==============================================
# BACKEND API CONFIGURATION
# ==============================================
# Nicht notwendig in Production (Frontend nutzt relative /api Pfade)
# Nur für Build-Time falls Vite das braucht:
VITE_BACKEND_URL=

# Railway Private Networking URL (WICHTIG!)
# Format: http://<backend-service-name>.railway.internal:4000
INTERNAL_BACKEND_URL=http://idpa-backend.railway.internal:4000

# ==============================================
# SERVER CONFIGURATION
# ==============================================
PORT=5173
```

**Wichtig:**

- ⚠️ **INTERNAL_BACKEND_URL**: Ersetze `idpa-backend` mit dem tatsächlichen Service-Namen deines Backends
  - Finde den Namen unter: **Backend Service** → **Settings** → **Service Name**
  - Oder nutze die Private Network URL aus Schritt 2.5

### 3.3 Deployment starten

1. Railway startet automatisch das Deployment
2. Überwache die Logs
3. Warte auf: ✅ `Build successful` → ✅ `Deployment live`

**Erwartete Log-Ausgaben:**
```
✅ vite build completed
✅ Frontend server listening on :5173
```

### 3.4 Public Domain generieren

1. Klicke auf **Frontend Service** → **Settings**
2. Scrolle zu **Networking** → **Public Networking**
3. Klicke **Generate Domain**
4. Railway erstellt eine URL: `your-app-production-xxxx.up.railway.app`

**Notiere dir diese URL:**
```
https://your-app-production-xxxx.up.railway.app
```

✅ **Frontend ist deployed!**

---

## Schritt 4: Services verbinden

### 4.1 Backend CORS aktualisieren

Jetzt wo du die Frontend-URL kennst, musst du CORS konfigurieren:

1. Gehe zu **Backend Service** → **Variables**
2. Finde `CORS_ALLOWED_ORIGINS`
3. Aktualisiere den Wert (❗ keine Leerzeichen, keine Trailing-Slashes):
   ```
   https://your-app-production-xxxx.up.railway.app
   ```
4. Klicke **Save**
5. Railway deployed automatisch neu

### 4.2 Appwrite Platform URLs aktualisieren

1. Gehe zu [cloud.appwrite.io/console](https://cloud.appwrite.io/console)
2. Öffne dein Projekt → **Settings** → **Platforms**
3. Bearbeite deine Web App:
   - **Hostname**: `your-app-production-xxxx.up.railway.app`
   - (ohne `https://` oder trailing `/`)
4. Gehe zu **Auth** → **Settings**
5. Füge deine Railway-URL zu den erlaubten **OAuth2 Redirect URLs** hinzu:
   ```
   https://your-app-production-xxxx.up.railway.app
   https://your-app-production-xxxx.up.railway.app/dashboard
   https://your-app-production-xxxx.up.railway.app/training
   ```

### 4.3 Connection testen

1. Öffne deine Frontend-URL im Browser
2. Klicke auf **Anmelden**
3. Teste Google OAuth oder E-Mail-Login
4. Nach erfolgreicher Anmeldung:
   - Gehe zu **Dashboard**
   - Erstelle einen Test-Chatbot
5. Überprüfe Backend-Logs:
   ```
   POST /api/chatbots → 201 Created
   ```

**Wenn alles funktioniert:**
- ✅ Login funktioniert
- ✅ Dashboard lädt Chatbots
- ✅ API-Calls kommen im Backend an

---

## Schritt 5: Domain konfigurieren (Optional)

### 5.1 Custom Domain hinzufügen

**Falls du eine eigene Domain hast:**

1. Klicke auf **Frontend Service** → **Settings** → **Networking**
2. Unter **Custom Domains** klicke **+ Add Domain**
3. Gebe deine Domain ein: z.B. `app.meine-domain.com`
4. Railway zeigt dir DNS-Records:
   ```
   Type: CNAME
   Name: app
   Value: your-app-production-xxxx.up.railway.app
   ```
5. Füge den CNAME-Record in deinem DNS-Provider hinzu
6. Warte auf DNS-Propagation (5-60 Minuten)

### 5.2 CORS & Appwrite für Custom Domain aktualisieren

**Nachdem die Domain aktiv ist:**

1. **Backend CORS**: Füge deine Domain zu `CORS_ALLOWED_ORIGINS` hinzu:
   ```
   https://your-app-production-xxxx.up.railway.app,https://app.meine-domain.com
   ```

2. **Appwrite Platforms**: Füge deine Custom Domain hinzu

3. **Frontend Embed Script**: Aktualisiere die `baseUrl` in `public/embed.js` falls notwendig

---

## Troubleshooting

### Problem: Backend Deployment schlägt fehl

**Fehler: `Prisma migration failed`**

**Lösung:**
1. Überprüfe, ob PostgreSQL-Plugin hinzugefügt wurde
2. Überprüfe, ob `DATABASE_URL` existiert (automatisch gesetzt)
3. Prüfe Backend-Logs nach SQL-Fehlern

**Fehler: `Invalid environment configuration`**

**Lösung:**
1. Prüfe alle Required-Variablen in `/IDPA_Backend/.env.example`
2. Stelle sicher, dass keine Tippfehler in den Variable-Namen sind
3. Prüfe Backend-Logs für Details:
   ```
   ❌ Invalid environment configuration: { JWT_SECRET: ['Required'] }
   ```

---

### Problem: Frontend kann Backend nicht erreichen

**Fehler in Browser Console: `Failed to fetch` oder CORS-Fehler**

**Lösung 1: CORS nicht konfiguriert**
- Überprüfe `CORS_ALLOWED_ORIGINS` im Backend
- Format: `https://domain.com` (keine Trailing-Slashes!)
- Keine Leerzeichen in kommaseparierten Listen

**Lösung 2: Falsche INTERNAL_BACKEND_URL**
- Überprüfe Frontend-Variable: `INTERNAL_BACKEND_URL`
- Muss dem Backend Service-Namen entsprechen
- Format: `http://<service-name>.railway.internal:4000`
- Finde den Service-Namen: Backend → Settings → Service Name

**Lösung 3: Backend läuft nicht**
- Gehe zu Backend Service → Deployments
- Prüfe Status: Sollte "Active" sein
- Öffne Logs und suche nach Fehlern

**Debugging:**
1. Öffne Frontend in Browser
2. Öffne Developer Tools (F12) → Network Tab
3. Versuche Dashboard zu laden
4. Prüfe API-Requests:
   - Request-URL sollte `/api/chatbots` sein (relativ)
   - Status sollte `200 OK` sein, nicht `502 Bad Gateway`

---

### Problem: Appwrite Login funktioniert nicht

**Fehler: `Redirect URI mismatch` oder `Invalid origin`**

**Lösung:**
1. Gehe zu Appwrite Console → Dein Projekt → Settings → Platforms
2. Überprüfe, ob die Railway-URL als Web Platform hinzugefügt ist
3. Format: `your-app-production-xxxx.up.railway.app` (kein `https://`)
4. Überprüfe OAuth-Settings: Auth → Settings → OAuth Providers
5. Stelle sicher, dass deine Railway-URL in den erlaubten Redirect-URLs ist

**Fehler: `User not found` nach Login**

**Lösung:**
- Überprüfe Backend-Logs während des Logins
- Suche nach: `Appwrite verification failed`
- Mögliche Ursachen:
  - `APPWRITE_API_KEY` ist falsch oder fehlt
  - `APPWRITE_PROJECT_ID` stimmt nicht überein
  - Appwrite-Service ist down

---

### Problem: OpenAI API Fehler

**Fehler: `OpenAI API key invalid`**

**Lösung:**
1. Überprüfe `OPENAI_API_KEY` im Backend
2. Format: `sk-proj-...` (neuere Keys) oder `sk-...` (alte Keys)
3. Teste den Key direkt: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
4. Überprüfe Billing: Stelle sicher, dass dein OpenAI-Account aktiv ist

**Fehler: `Rate limit exceeded`**

**Lösung:**
- Du hast dein OpenAI-Limit erreicht
- Upgrade deinen OpenAI-Plan oder warte bis zum nächsten Monat
- Überprüfe Usage: [platform.openai.com/usage](https://platform.openai.com/usage)

**Mock-Modus verwenden (für Testing ohne OpenAI):**
- Entferne `OPENAI_API_KEY` aus Backend-Variablen
- Backend fällt automatisch auf Mock-Responses zurück
- ⚠️ AI-Features funktionieren nicht richtig, nur für Entwicklung!

---

### Problem: Database Migration Fehler

**Fehler: `P3009: migrate found failed migrations`**

**Lösung:**
1. Gehe zu Backend Service → Data → PostgreSQL
2. Öffne die Datenbank-Console (oder nutze Railway CLI)
3. Lösche die fehlgeschlagene Migration:
   ```sql
   DELETE FROM "_prisma_migrations"
   WHERE migration_name = '<failed-migration-name>';
   ```
4. Triggere ein neues Deployment (Backend → Deployments → Redeploy)

**Alternativ: Datenbank zurücksetzen (❗ löscht alle Daten):**
1. Lösche das PostgreSQL-Plugin
2. Füge ein neues PostgreSQL-Plugin hinzu
3. Railway deployed automatisch neu und erstellt ein frisches Schema

---

### Problem: Railway Build Timeout

**Fehler: `Build exceeded maximum time limit`**

**Lösung:**
- Railway Free Plan hat Build-Limits
- Optimiere deine Dependencies:
  ```bash
  # Im Projekt:
  npm prune --production
  npm dedupe
  ```
- Upgrade zu Railway Pro Plan für längere Build-Zeiten

---

### Problem: Logs anzeigen

**Railway Logs ansehen:**
1. Klicke auf dein Service (Frontend oder Backend)
2. Gehe zu **Deployments**
3. Klicke auf die aktive Deployment
4. Klicke **View Logs**
5. Filter nach Log-Level: Info, Warning, Error

**Live-Logs in Terminal (Railway CLI):**
```bash
# Railway CLI installieren
npm install -g @railway/cli

# Login
railway login

# Logs streamen
railway logs
```

---

### Problem: Service startet nicht nach Deployment

**Symptom: Deployment erfolgreich, aber Service ist "Crashed"**

**Lösung:**
1. Öffne Logs und suche nach dem letzten Fehler
2. Häufige Ursachen:
   - **Missing Environment Variable**: Prüfe alle Required-Variablen
   - **Port-Konflikt**: Railway injiziert `PORT` automatisch
   - **Dependency-Fehler**: Prüfe `package.json` nach fehlenden Packages

**Health-Check konfigurieren:**
- Railway prüft automatisch ob der Service antwortet
- Stelle sicher, dass dein Service auf `0.0.0.0:$PORT` hört (nicht `localhost`)
- Backend sollte `/healthz` Endpoint exponieren (ist bereits implementiert)

---

## Environment-Variablen Referenz

### Backend Service - Vollständige Liste

| Variable | Required | Beispielwert | Beschreibung |
|----------|----------|--------------|--------------|
| `NODE_ENV` | ✅ | `production` | Runtime-Umgebung |
| `PORT` | ✅ | `4000` | Server-Port (automatisch von Railway) |
| `DATABASE_URL` | ✅ | `postgresql://...` | Postgres Connection String (automatisch) |
| `JWT_SECRET` | ✅ | `<random-32-chars>` | Secret für Session-Tokens |
| `SESSION_TTL_MINUTES` | ❌ | `60` | Chat-Session Lebensdauer |
| `RATE_LIMIT_PER_MINUTE` | ❌ | `60` | API Rate-Limit |
| `ALLOW_DEBUG_HEADERS` | ❌ | `false` | Debug-Modus (nur Development) |
| `CORS_ALLOWED_ORIGINS` | ✅ | `https://app.railway.app` | Erlaubte Frontend-Origins (kommasepariert) |
| `APPWRITE_ENDPOINT` | ✅ | `https://fra.cloud.appwrite.io/v1` | Appwrite API URL |
| `APPWRITE_PROJECT_ID` | ✅ | `6914520c000ee1da7505` | Deine Appwrite Projekt-ID |
| `APPWRITE_API_KEY` | ✅ | `<api-key>` | Appwrite Server API Key |
| `APPWRITE_SELF_SIGNED` | ❌ | `false` | Self-Signed Certs erlauben |
| `OPENAI_API_KEY` | ✅ | `sk-proj-...` | OpenAI API Key |
| `OPENAI_COMPLETIONS_MODEL` | ❌ | `gpt-4o-mini` | LLM-Modell für Chat |
| `OPENAI_EMBEDDINGS_MODEL` | ❌ | `text-embedding-3-small` | Embedding-Modell |
| `VECTOR_DB_PROVIDER` | ❌ | `memory` oder `pinecone` | Vector Store Backend |
| `PINECONE_API_KEY` | ⚠️ | `<api-key>` | Nur wenn `VECTOR_DB_PROVIDER=pinecone` |
| `PINECONE_INDEX` | ⚠️ | `chatbot-embeddings` | Nur wenn `VECTOR_DB_PROVIDER=pinecone` |
| `SCRAPER_APIFY_ACTOR_ID` | ⚠️ | `timo.sieber~idpa-scraper` | Optional: Apify Cloud Scraper |
| `SCRAPER_APIFY_API_TOKEN` | ⚠️ | `<token>` | Nur wenn Apify genutzt wird |
| `PERPLEXITY_API_KEY` | ⚠️ | `<api-key>` | Optional: Erweiterte PDF-Extraktion |

**Legende:**
- ✅ **Required**: Muss gesetzt sein, sonst startet Service nicht
- ⚠️ **Conditional**: Nur bei bestimmten Features notwendig
- ❌ **Optional**: Hat Default-Werte

---

### Frontend Service - Vollständige Liste

| Variable | Required | Beispielwert | Beschreibung |
|----------|----------|--------------|--------------|
| `PORT` | ❌ | `5173` | Server-Port (automatisch von Railway) |
| `VITE_APPWRITE_PROJECT_ID` | ✅ | `6914520c000ee1da7505` | Appwrite Projekt-ID |
| `VITE_APPWRITE_API_ENDPOINT` | ✅ | `https://fra.cloud.appwrite.io/v1` | Appwrite API URL |
| `VITE_BACKEND_URL` | ❌ | ` ` | Development-Only (leer lassen für Production) |
| `INTERNAL_BACKEND_URL` | ✅ | `http://idpa-backend.railway.internal:4000` | Private Backend-URL für Proxy |

**Wichtig:**
- `VITE_*` Variablen werden beim Build-Time eingebettet
- `INTERNAL_BACKEND_URL` wird von `server/serve.mjs` zur Runtime genutzt

---

## Railway CLI Commands (Optional)

### Installation

```bash
npm install -g @railway/cli
railway login
```

### Nützliche Commands

```bash
# Projekt verlinken
railway link

# Variablen anzeigen
railway variables

# Variable setzen
railway variables set KEY=VALUE

# Logs streamen
railway logs

# Shell im Service öffnen
railway shell

# Neues Deployment triggern
railway up

# Aktuellen Status anzeigen
railway status
```

---

## Monitoring & Maintenance

### Logs überwachen

**Wichtige Log-Patterns zum Suchen:**

**Backend:**
```
✅ "Server listening on" - Server gestartet
⚠️ "Rate limit exceeded" - User trifft Limit
❌ "OpenAI API error" - AI-Service Problem
❌ "Appwrite verification failed" - Auth-Problem
```

**Frontend:**
```
✅ "Frontend server listening" - Server gestartet
❌ "Proxy-Fehler" - Backend nicht erreichbar
```

### Railway Metrics

1. Gehe zu **Service** → **Metrics**
2. Überwache:
   - **CPU Usage**: Sollte unter 80% bleiben
   - **Memory Usage**: Sollte unter Limit bleiben
   - **Network**: Request-Volume
   - **Response Times**: Sollte unter 500ms sein

### Kosten überwachen

1. Gehe zu **Project** → **Settings** → **Usage**
2. Railway zeigt:
   - Execution-Minutes used
   - Network Bandwidth
   - Projected monthly cost

**Free Tier Limits:**
- $5 credit pro Monat
- ~500 Execution Hours
- Sleeps bei Inaktivität (Frontend nicht betroffen)

---

## Produktions-Checkliste

Vor dem Go-Live:

- [ ] **Backend deployed & erreichbar** (`/healthz` gibt 200 zurück)
- [ ] **Frontend deployed & erreichbar**
- [ ] **PostgreSQL Plugin** hinzugefügt & Migrations laufen
- [ ] **CORS korrekt konfiguriert** (Frontend-URL in Backend)
- [ ] **Appwrite Platforms** konfiguriert (Frontend-URL)
- [ ] **OpenAI API Key** gesetzt & getestet
- [ ] **JWT_SECRET** generiert (nicht `change-me`!)
- [ ] **Pinecone** konfiguriert (oder `VECTOR_DB_PROVIDER=memory`)
- [ ] **Custom Domain** konfiguriert (optional)
- [ ] **SSL Certificates** automatisch erstellt (Railway macht das)
- [ ] **Environment-Variablen** reviewed (keine Secrets in Logs!)
- [ ] **Login getestet** (Google OAuth + E-Mail)
- [ ] **Chatbot erstellen** getestet
- [ ] **Chat-Widget** auf Test-Seite eingebettet & getestet
- [ ] **Budget-Limits** gesetzt (OpenAI, Pinecone, Railway)
- [ ] **Error-Monitoring** aktiv (prüfe Logs regelmäßig)

---

## Nächste Schritte

Nach erfolgreichem Deployment:

1. **Monitoring einrichten**:
   - Sentry für Error-Tracking
   - Uptime-Monitor (UptimeRobot, Pingdom)

2. **Performance optimieren**:
   - Railway CDN aktivieren
   - Image-Optimization
   - Lazy-Loading

3. **Features erweitern**:
   - Custom Domains für Chatbots
   - Analytics Dashboard
   - A/B Testing

4. **Backup-Strategie**:
   - Railway macht automatische Postgres-Backups
   - Externe Backups für kritische Daten

---

## Support & Ressourcen

- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Railway Discord**: [discord.gg/railway](https://discord.gg/railway)
- **Appwrite Docs**: [appwrite.io/docs](https://appwrite.io/docs)
- **OpenAI Docs**: [platform.openai.com/docs](https://platform.openai.com/docs)
- **Pinecone Docs**: [docs.pinecone.io](https://docs.pinecone.io)

---

## Changelog

- **2025-11-20**: Initiales Deployment-Guide erstellt
- Railway Konfiguration hinzugefügt
- Environment-Variablen dokumentiert
- Troubleshooting-Section erweitert

---

**Viel Erfolg beim Deployment! 🚀**

Bei Fragen oder Problemen kannst du die Railway-Logs prüfen oder die Community um Hilfe bitten.
