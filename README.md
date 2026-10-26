# swiki-backend

Backend API for **swiki**, a small collaborative wiki whose documents are laid out on a 2D "trend map" grid and searched by title embeddings. The frontend (a separate repository) talks to this service over REST and WebSocket.

**Status:** Prototype — a working Bun/Elysia server with auth, document CRUD, two collaboration channels and embedding search. Stored data is SQLite, Prisma migrations are not committed (`prisma db push` is used), there is one unit test file, and parts of the code (`/wiki/ws/doc/:id` presence/cursor payloads, uploads) are unpolished.

## Features

- Email/password auth with Argon2 hashing, access + refresh JWTs delivered as cookies or `Authorization: Bearer`, role check helper (`src/auth/guard.ts`)
- Wiki documents (markdown + optional BlockNote JSON snapshot, tags, views, edit history) stored via Prisma
- Real-time collaboration:
  - `WS /wiki/ws/doc/:id` — Elysia WebSocket room per document; JSON messages `edit`, `join`, `cursor`; content is cached in memory and flushed to the DB (with a `History` entry) when the last editor leaves
  - A separate Yjs-compatible WebSocket server (`src/yws/server.ts`, default `ws://localhost:8001/yws/:room`) speaking the y-websocket sync/awareness protocol for CRDT editors; rooms are in-memory only
- Title embeddings via Google Gemini (`gemini-embedding-001`, 768 dims) with a deterministic local fallback when the API is unavailable; cosine-similarity search and search-driven graph browsing
- Grid "trend map" (`src/browse/grid.ts`): places documents on an integer grid (nearest-free-cell or spiral), supports `trending`, `around (x, y)` and `box` queries, TTL cleanup, optional JSON persistence
- Global and per-route rate limiting, security headers, request logging, daily JSON log files, Swagger UI outside production

## How it works

`src/index.ts` creates the Elysia app, mounts CORS/cookie/rate-limit/security/logging middleware, serves `public/`, and registers four route groups: `auth/` (`/auth/*`), `wiki/` (`/wiki/*`), `search/` (`/search*`) and `admin/` (`/admin/*`). It also starts the Yjs WebSocket server from `yws/server.ts` on its own port. Persistence is Prisma over SQLite (`prisma/schema.prisma`: `User`, `Role`, `Document`, `History`, `Tag`). `embedding.ts` wraps the Gemini client; `browse/` holds the grid service, layout/score helpers and schemas; `document/cache.ts` is the write-behind cache used by the document WebSocket.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/`, `/health` | redirect to health / `"OK"` |
| POST | `/auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout` | login 5/min, register 3/hour |
| GET | `/auth/me` | current JWT payload |
| GET | `/wiki/browse/trending?n&k` | top documents as `{ nodes, edges }` |
| GET | `/wiki/browse/around?x&y&c` | BFS from the nearest occupied cell |
| GET | `/wiki/browse/box?...` | documents inside a grid box (bounded by `GRID_MAX_BOX_*`) |
| POST | `/wiki/documents`, `/wiki/docs` | create a document (`title`, `tags`) |
| GET / PATCH | `/wiki/docs/:id` | read / update a document |
| POST | `/wiki/uploads` | multipart file upload → `{ url }` |
| WS | `/wiki/ws/doc/:id` | collaborative editing room (see above) |
| GET | `/search?q&k` | embedding search → `{ id, title, score }[]` |
| GET | `/search/browse?q&n&k` | graph around a query embedding |
| GET | `/admin/grid/metrics` | requires header `x-admin-token` |

Swagger is served at `/swagger` when `NODE_ENV` is not `production`.

## Tech stack

- Runtime/Language: Bun, TypeScript
- Framework: Elysia (`@elysiajs/jwt`, `cookie`, `cors`, `static`, `swagger`), TypeBox schemas (`prismabox` generates them from the Prisma schema)
- Storage: SQLite via Prisma 6
- Collaboration: `yjs`, `y-protocols`, `lib0`, `ws`
- Embeddings: `@google/genai`
- Auth: `argon2`

## Getting started

### Requirements

- Bun 1.x
- A Gemini API key (optional — without it embeddings fall back to a deterministic pseudo-embedding, so search still runs but is not semantic)

### Install

```bash
git clone https://github.com/eunhhu/swiki-backend.git
cd swiki-backend
bun install
cp .env.example .env     # edit values, see Configuration
bun run db:generate      # prisma generate (+ prismabox types)
bun run db:push          # create the SQLite schema
bun run db:seed          # optional: prisma/seed.ts
```

### Run

```bash
bun run dev              # --watch src/index.ts, HTTP on :8000, Yjs WS on :8001
bun test                 # tests/ (grid "around" queries)
bun run db:studio        # Prisma Studio
```

Helper scripts: `scripts/e2e_grid_test.ts`, `scripts/validate_xy.ts` (grid checks), `scripts/test_auth.ps1` (PowerShell auth smoke test).

## Project structure

```
src/
├── index.ts           # app wiring, middleware, route registration
├── auth/              # login/register/refresh/me/logout, JWT plugin, role guard, argon2 util
├── wiki/              # documents, browse endpoints, uploads, /ws/doc/:id room
├── search/            # /search and /search/browse
├── admin/             # /admin/grid/metrics
├── browse/            # GridMapService, layout, scoring, schemas
├── document/          # in-memory doc cache + content hashing
├── embedding.ts       # Gemini embeddings with fallback
├── yws/server.ts      # Yjs-compatible WebSocket server
├── middleware/        # rateLimit, securityHeaders, requestLogger
├── api/, logger.ts, utils/env.ts, types/
prisma/                # schema.prisma, seed.ts
data/grid.json         # persisted grid layout (GRID_PERSIST_PATH)
public/                # static assets
tests/, scripts/
```

## Configuration

Environment variables read by the code (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP port |
| `DATABASE_URL` | — | Prisma SQLite URL, e.g. `file:./db.sqlite` |
| `YWS_PORT`, `YWS_PATH` | `8001`, `/yws` | Yjs WebSocket server |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | dev fallbacks; required in production | JWT signing |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | `1h`, `7d` | token lifetimes |
| `GEMINI_API_KEY` | — | Gemini embeddings; fallback used if missing/failing |
| `ALLOWED_ORIGINS` | localhost:3000/5173/`PORT` | comma-separated CORS origins |
| `GRID_MAX_N`, `GRID_MAX_K`, `GRID_MAX_C` | — | caps for browse/search parameters |
| `GRID_MAX_BOX_SPAN`, `GRID_MAX_BOX_RESULTS` | — | caps for `/wiki/browse/box` |
| `GRID_PLACEMENT` | `nearest` | `nearest` or `spiral` placement |
| `GRID_TTL_MS`, `GRID_CORE_RADIUS` | — | grid cleanup interval and protected core radius |
| `GRID_PERSIST_PATH` | — | file to persist the grid; empty disables |
| `ADMIN_TOKEN` | — | value for the `x-admin-token` header |
| `LOG_DIR` | `logs` | directory for daily JSON logs |
| `NODE_ENV` | — | `production` disables Swagger, hides error details, hardens cookies |

## License

No license file yet.
