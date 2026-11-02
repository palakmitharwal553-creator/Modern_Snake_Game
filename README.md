# NUMBER SNAKE — Full-Stack Edition

A modern take on Snake featuring numbered food tiles collected in sequential order (1, 2, 3...), dynamic power-ups, milestone certificates, account authentication, and a real-time global leaderboard powered by Node.js, Express, and MongoDB Atlas.

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
- **Global Leaderboard**:
  - Tabs: **All Modes**, **Normal**, **No Walls**.
  - Consistent ranking: higher score ranks higher, earlier achievement date is tiebreaker.
  - Dedicated personal rank badge (`.lb-mine`) showing player rank even if outside the top 10.
  - Nickname system with server-side sanitization.
  - Seamless automatic submission via `window.NSLeaderboard.submit(modeId)`.
- **Guest & Authenticated User Support**:
  - Guests can play immediately with full local storage persistence and nickname submission.
  - Registered players can sign up with email and securely persist scores and certificates in MongoDB Atlas.
- **Database & Resilience**:
  - Primary database: **MongoDB Atlas** (`number_snake_db`).
  - Automatic fallback to persistent local JSON database (`data/db.json`) when offline or before Atlas credentials are configured.

---

## Project Structure

```
number-snake/
├── index.html          # Semantic HTML: board, HUD, start/pause/game-over overlays, leaderboard, auth
├── style.css           # 3D dark gaming theme, responsive CSS grid, animations, .lb classes
├── script.js           # Part 1: Pure game logic (Node-testable); Part 2: Canvas renderer + NSLeaderboard
├── server.js           # Express app: API routes, static serving, session management
├── package.json        # Dependencies (Express, MongoDB driver, bcryptjs, express-session, connect-mongo)
├── .env.example        # Environment variable template
├── .env                # Local environment secrets (ignored by git)
├── .gitignore          # Git ignore rules (.env, node_modules, data/db.json)
├── db/
│   └── mongo.js        # MongoDB Atlas connection manager with resilient offline fallback
├── routes/
│   ├── auth.js         # Authentication API: register, login, logout, me
│   ├── leaderboard.js  # Leaderboard API: submit score, fetch rankings, mode filters
│   ├── runs.js         # Game runs API
│   └── certs.js        # Certificate milestone recording API
└── test/
    └── verify.js       # Automated test suite (14 end-to-end tests)
```

---

## Environment Configuration

Create a `.env` file in the root of the project (copy from `.env.example`):

```env
# MongoDB Atlas Connection URI
MONGODB_URI=mongodb+srv://<username>:<password>@StudentHubCluster.mongodb.net/?retryWrites=true&w=majority&appName=StudentHubCluster

# Secret string used to sign session cookies
SESSION_SECRET=your_long_random_session_secret_string

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
   - `users`: User profiles and hashed credentials with unique `email` index.
   - `game_runs`: Complete log of completed games.
   - `leaderboard`: Deduplicated highest scores per player per mode with `{ score: -1, playedAt: 1 }` index.
   - `certificates`: Milestones achieved with unique compound index `{ userId: 1, rankIdx: 1 }`.
   - `sessions`: Active user sessions managed automatically by `connect-mongo`.

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

### Leaderboard API
- `GET /api/leaderboard?mode=all` — Retrieve top rankings (modes: `all`, `normal`, `nowalls`).
- `GET /api/leaderboard?mode=normal&playerId=<id>` — Returns top entries and the specific player's rank.
- `POST /api/leaderboard/submit` — Submit a completed game score.
- `GET /api/leaderboard/player?playerId=<id>` — Returns player's personal records.
- `GET /api/leaderboard/stats` — Global game statistics.

### Authentication API
- `POST /api/register` — Create a new account (`username`, `email`, `password`).
- `POST /api/login` — Authenticate and start session (`email`, `password`).
- `POST /api/logout` — End session.
- `GET /api/me` — Retrieve active session user.

### Runs & Certificates
- `POST /api/runs` — Save run metadata.
- `POST /api/certs` — Save certificate download milestone.

---

## Automated Testing

Run the included verification suite:

```powershell
node test/verify.js
```

All 14 tests covering authentication, score submission, sanitization, mode separation, tie-breaking, and session management will be executed.
