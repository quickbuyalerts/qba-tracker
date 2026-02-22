# QBA TRACKER

Live Solana memecoin tracker with real-time RSI, ATH tracking, and terminal-style UI.

## Architecture

- **Frontend**: Next.js 14 (App Router) — dark terminal UI with SSE live updates
- **Server**: Node.js + Fastify — background collector, SSE streaming, Redis persistence
- **Database**: Upstash Redis — crash recovery and state persistence

## Local Development

### Prerequisites

- Node.js 20+
- Upstash Redis account (free tier works)

### Setup

```bash
# Clone and enter project
cd qba-tracker

# Copy env vars
cp .env.example .env
# Edit .env with your Upstash credentials

# Install server dependencies
cd server && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### Run

```bash
# Terminal 1: Start server
cd server
PORT=3001 node src/index.js

# Terminal 2: Start frontend
cd frontend
NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev
```

Open http://localhost:3000

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `UPSTASH_REDIS_URL` | Upstash Redis REST URL | — |
| `UPSTASH_REDIS_TOKEN` | Upstash Redis REST token | — |
| `PORT` | Server port | `3001` |
| `NEXT_PUBLIC_API_URL` | Server URL for frontend | `http://localhost:3001` |

## Docker

```bash
docker-compose up --build
```

## Deploy

### Server → Render.com

1. Create a new **Web Service** on Render
2. Connect your repo, set root directory to `server`
3. Build command: `npm install`
4. Start command: `node src/index.js`
5. Add environment variables: `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`, `PORT=3001`

### Frontend → Vercel

1. Import project on Vercel
2. Set root directory to `frontend`
3. Framework preset: Next.js
4. Add environment variable: `NEXT_PUBLIC_API_URL` = your Render server URL (e.g., `https://qba-server.onrender.com`)

### Redis → Upstash

1. Create a free Redis database at https://upstash.com
2. Copy the REST URL and token to your env vars

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check |
| `GET /api/stats` | Collector statistics |
| `GET /api/snapshot` | Full current state |
| `GET /api/stream` | SSE event stream |

## Data Sources

- **Discovery**: Dexscreener search API (every 30s)
- **Live stats**: Dexscreener pairs API (every 10s)
- **OHLCV**: GeckoTerminal 5m candles (every 60s, staggered)
