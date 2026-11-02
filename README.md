# NUMBER SNAKE — Full-Stack Edition

A modern take on Snake featuring numbered food tiles collected in sequential order (1, 2, 3...), dynamic power-ups, milestone certificates, a per-device player name (no sign-in), and a real-time global leaderboard powered by Node.js, Express, and MongoDB Atlas.

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
  - Certificates (PNG) unlock at 50+ (Pro), 80+ (Expert) and 120+ (Legend), always with the player's saved name.
- **One player per device, no sign-in**:
  - On the first visit the game asks for a name once. The name and a random device id are kept in the browser, so the same name is used every time on that device.
  - The name can be changed with **Your Name / Save** in the Leaderboard section. Old scores move to the new name.
  - Nothing to sign up for: there are no accounts, passwords or sessions.
- **Leaderboard** (tabs **Normal**, **No Walls**, **Overall**):
  - One row per device and mode. Higher score ranks higher, the earlier achievement wins a tie.
  - Overall shows each device once with its best score in any mode.
  - Your own row is highlighted and your rank is shown even outside the top 10.
  - Scores are sent automatically at game over. If the server is offline they are kept on the device and sent later.
- **Sound**: soft, smooth sound effects with an on/off button in the header (saved on the device).
- **Database & Resilience**:
  - Primary database: **MongoDB Atlas** (`number_snake_db`).
  - Automatic fallback to a persistent local JSON database (`data/db.json`) when offline or before Atlas credentials are configured.

---

## Project Structure

```
number-snake/
├── index.html          # board, HUD, start/pause/game-over screens, leaderboard, name dialog
├── style.css           # dark gaming theme, responsive layout
├── script.js           # game logic + canvas renderer + player/leaderboard/sound module
├── server.js           # Express app: API routes, serves the three game files
├── package.json        # Dependencies (Express, MongoDB driver, rate limiter, dotenv)
├── .env.example        # Environment variable template
├── db/mongo.js         # Atlas connection with local JSON fallback
├── lib/service.js      # Player, score, ranking and certificate logic (no Express)
├── routes/
│   ├── player.js       # POST/GET /api/player
│   ├── leaderboard.js  # rankings, submit, player stats
│   └── certs.js        # certificate records
└── test/verify.js      # automated checks (node test/verify.js)
```

---

## Environment Configuration

Create a `.env` file in the root of the project (copy from `.env.example`):

```env
MONGODB_URI=mongodb+srv://<username>:<password>@StudentHubCluster.mongodb.net/?retryWrites=true&w=majority&appName=StudentHubCluster
PORT=3000
# TRUST_PROXY=1   (set when hosted behind a proxy)
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
   - `players`: one document per device (`playerId`, `name`) with a unique `playerId` index.
   - `game_runs`: Complete log of completed games.
   - `leaderboard`: Deduplicated highest scores per player per mode with `{ score: -1, playedAt: 1 }` index.
   - `certificates`: Milestones achieved with unique compound index `{ playerId: 1, rankIdx: 1 }`.

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

- `POST /api/player` — save or change this device's name (`playerId`, `name`).
- `GET /api/player?playerId=<id>` — name, best scores, recent runs, game and certificate counts.
- `GET /api/leaderboard?mode=normal|nowalls|all&playerId=<id>` — top 10 and the device's own rank.
- `POST /api/leaderboard/submit` — send a finished game (`playerId`, `nickname`, `score`, `mode`, `runToken`).
- `GET /api/leaderboard/player?playerId=<id>` — same data as `GET /api/player`.
- `GET /api/leaderboard/stats` — overall statistics.
- `POST /api/certs` — record a certificate download (`playerId`, `rankIdx` 3/4/5, `score`, `mode`, `playerName`). The server checks that the device really reached that score.

---

## Automated Testing

```powershell
npm test
```

Runs the service logic against a temporary local database: name cleaning, score validation, ranking and tie-breaks, separate modes, Overall board, renaming, certificates and persistence.
