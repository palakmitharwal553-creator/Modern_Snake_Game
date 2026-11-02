# NUMBER SNAKE — Full-Stack Edition

A modern take on Snake featuring numbered food tiles collected in sequential order (1, 2, 3...), dynamic power-ups, milestone certificates, device-based players (no login), and a real-time global leaderboard powered by Node.js, Express, and MongoDB Atlas.

---

## Features

- **Pure JavaScript Game Engine**: 24x24 grid, 4-way turn buffering, collision detection, and canvas particle system.
- **Two Game Modes**:
  - **Normal**: Deadly walls, +1 growth per food tile, Plus power-up (wall immunity).
  - **No Walls**: Screen wrapping, +2 growth per food tile, faster speed scaling.
- **Power-Ups & Hazards**:
  - **Stopwatch**: Slows speed for 35 seconds.
  - **Shield / Plus**: Wall pass-through immunity for 12 seconds.
  - **Bomb**: Deadly obstacle that blinks and vanishes after 9 seconds.
- **Rank System & Canvas Certificates**:
  - Ranks: Rookie (0), Explorer (10), Skilled (25), Pro (50), Expert (80), Legend (120).
  - Generates downloadable high-resolution 1600x1130 PNG achievement certificates.
- **Device-based players (no login)**:
  - The first visit generates a Device ID with `crypto.randomUUID()` and stores it in `localStorage` as `numberSnakeDeviceId`.
  - The player is asked for a display name once; it is saved in MongoDB Atlas (one record per Device ID, unique index). Returning visits reuse the profile. The name can be edited at any time.
  - There are no accounts, emails or passwords.
- **One Global Leaderboard**:
  - One entry per device across ALL modes (Normal and No Walls share one personal best).
  - Order: best score (high to low), then the earlier achievement time, then a fixed fallback (the record's `_id`).
  - Shows rank, name, best score, best mode and achievement date. Top 50 are listed; your own rank is always shown, even outside the top 50.
  - Every finished game is submitted automatically with a unique game ID. Duplicates are rejected by a MongoDB unique index. Games that cannot be sent (offline) are retried later.
  - After each game the server returns your new rank and whether you moved up, moved down, entered the leaderboard or stayed.
  - Ranks are always calculated on the server.
- **Database**:
  - **MongoDB Atlas** (`number_snake_db`) is required. If it cannot be reached the server refuses to start; there is no local JSON fallback.

---

## Project Structure

```
number-snake/
├── index.html          # Semantic HTML: board, HUD, start/pause/game-over overlays, leaderboard, name dialog
├── style.css           # 3D dark gaming theme, responsive CSS grid, animations, .lb classes
├── script.js           # Part 1: Pure game logic (Node-testable); Part 2: Canvas renderer + NSLeaderboard
├── server.js           # Express app: API routes and static serving (no sessions)
├── package.json        # Dependencies (Express, MongoDB driver, express-rate-limit, dotenv)
├── .env.example        # Environment variable template
├── .env                # Local environment secrets (ignored by git)
├── .gitignore          # Git ignore rules (.env, node_modules, data/db.json)
├── db/
│   └── mongo.js        # MongoDB Atlas connection manager and index setup
├── routes/
│   ├── leaderboard.js  # Players, score submission, ranks and the global leaderboard
│   └── certs.js        # Certificate milestone recording API
└── test/
    └── device_leaderboard.js  # Integration test for players, scores and ranks
```

---

## Environment Configuration

Create a `.env` file in the root of the project (copy from `.env.example`):

```env
# MongoDB Atlas Connection URI
MONGODB_URI=mongodb+srv://<username>:<password>@StudentHubCluster.mongodb.net/?retryWrites=true&w=majority&appName=StudentHubCluster

# Port to listen on (default 3000)
PORT=3000

# Environment mode ('development' or 'production')
NODE_ENV=development
```

> **Security Note:** Never commit `.env` to Git. The `.gitignore` file is configured to exclude it.

---

## MongoDB Atlas Setup

1. Log into your [MongoDB Atlas](https://cloud.mongodb.com/) account.
2. Select your cluster: **StudentHubCluster**.
3. Under **Database Access**, create a database user with read and write privileges.
4. Under **Network Access**, ensure your current IP address (or `0.0.0.0/0` for universal development access) is whitelisted.
5. Database name used by the application:
   - **`number_snake_db`**
6. Collections used:
   - `players`: one document per device (unique `deviceId`): display name, `bestScore`, `bestMode`, `bestScoreAchievedAt`, `latestScore`, `gamesPlayed`, `lastPlayedAt`. Ranking index `{ bestScore: -1, bestScoreAchievedAt: 1, _id: 1 }`.
   - `game_runs`: one document per completed game, unique index on `{ deviceId, gameId }` (rejects duplicate submissions).
   - `certificates`: milestones downloaded, unique index on `{ deviceId, rankIdx }`.
   - Older collections (`users`, `leaderboard`, `sessions`) are no longer used but are never deleted or modified.

*Note: All collections and indexes are ensured automatically when the server connects.*

---

## How to Run

### 1. Install Dependencies

```powershell
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and enter your credentials. If running offline or with placeholders, the server will automatically use local persistent JSON storage.

### 3. Start the Server

```powershell
# Production / Normal start
npm start

# Development mode with auto-reload
npm run dev
```

Open your browser to:
**`http://localhost:3000`**

---

## API Endpoints

The browser sends its Device ID in the `X-Device-Id` header (and in the JSON body for writes). The Device ID is never returned in any response.

### Players and leaderboard
- `GET  /api/leaderboard?limit=50` — Top players (max 50) plus `me`: the calling device's own rank, even outside the top 50.
- `GET  /api/leaderboard/player` — The caller's profile (name, rank, best score, latest score, games played), or `registered: false`.
- `POST /api/leaderboard/player` — Register this device (`displayName`). Safe to call again: it never creates a second player.
- `PUT  /api/leaderboard/player/name` — Change the display name.
- `POST /api/leaderboard/submit` — Submit one finished game (`gameId`, `score`, `mode`, `playedAt`). Returns `previousRank`, `rank` and `movement` (`entered`, `up`, `down`, `same`, `unranked`).
- `GET  /api/leaderboard/stats` — Global statistics.

### Certificates
- `POST /api/certs` — Save a certificate download milestone for this device.

---

## Automated Testing

The integration test needs a MongoDB replica set (MongoDB Atlas is one) because score submission uses a transaction. Run it against a throw-away database, never the live one:

```powershell
$env:MONGODB_DB = "number_snake_test"
node test/device_leaderboard.js
```

`test/verify.js` and `test/e2e_verify.js` were written for the old account system (login, sessions, `/api/runs`) and no longer apply.