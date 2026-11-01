# NUMBER SNAKE

A modern take on Snake. The snake is red, and instead of a plain food ball you eat **numbers in order**: 1, then 2, then 3, and so on. Built with plain HTML, CSS and vanilla JavaScript. No libraries, no build step, no backend.

## How to run

**Option 1 (simplest):** unzip the folder and double-click `index.html`. It opens in your default browser and works offline.

**Option 2 (local server, optional):** from inside the project folder run one of these, then open the printed address:

```
python3 -m http.server 8000     # then visit http://localhost:8000
npx serve .                     # if you have Node.js
```

Any current version of Chrome, Edge, Firefox or Safari works.

## How to play

1. Pick a **mode** on the start screen, then press **Play Game**.
2. Eat the numbers in order. The first number is **1**, then **2**, **3**, **4**, and so on. The "Next number" card always shows which one to collect.
3. Each number you eat adds **1 to your score** and grows your snake, and the next number appears in a new free spot.
4. The game speeds up as your score climbs, up to a playable limit.
5. Hitting your **own body** ends the game, and so does eating a **bomb**. In Normal mode a **wall** does too.

### Game modes

| | Normal | No walls |
| --- | --- | --- |
| Edges | Deadly | Wrap around: the head re-enters from the opposite side |
| Level up every | 5 points | 3 points |
| Speed at level 1 | 150 ms per move (6.7 moves/s) | 140 ms per move (7.1 moves/s) |
| Fastest speed | 70 ms (14.3 moves/s) | 60 ms (16.7 moves/s) |
| Growth per number | 1 segment | 2 segments |
| Plus power-up | Yes | No (walls are harmless anyway) |

The speed ramps up sooner and the snake gets long quickly in No walls mode, so it is easy to grow but harder to stay in control. Each mode keeps its **own highest score**, and the game remembers the mode you chose last. On the start screen, left / right (or **1** / **2**) switches mode. Use **Change mode** on the pause or game over screen to go back to the start screen.

### Power-ups

Power-ups and bombs appear at random every 5 to 9 seconds and vanish after a while (they blink for the last 3 seconds). Their timers only run while the game is running, so pausing stops everything.

| Icon | Name | Effect |
| --- | --- | --- |
| Gold stopwatch | Slow-down | Holds the game at level 1 or 2 speed for **35 seconds**, even while your score keeps climbing. Scoring and growth work as normal. When it ends, the speed jumps back to the level you have earned. |
| Green plus | Wall immunity | For **12 seconds** walls cannot hurt you: you pass through and come out on the opposite side. The board edge turns green and dashed while it is active, and it flickers in the last seconds. Normal mode only. |
| Black bomb | Bomb | Eating it ends the game. Bombs never appear before score 3, never closer than 4 cells to your head, and there are at most 2 at a time. |

Active power-ups show as small timer chips in the top-left corner of the board.

### Ranks and certificate

Your rank depends on your score in the current run and is shown under the score. A short animation plays when you reach a new rank.

| Rank | Score |
| --- | --- |
| Rookie | 0 - 9 |
| Explorer | 10 - 24 |
| Skilled | 25 - 49 |
| Pro | 50 - 79 |
| Excellent | 80 - 119 |
| Legend | 120 and above |

Reach **50 points (Pro)** or more and the game over screen offers a **Download Certificate** button. Enter your name and the game creates a PNG certificate with your name, score, mode, rank and date. Your name is remembered in the browser.

The snake starts with **2 blocks** on a **24 x 24** board.

### Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Steer | Arrow keys or W A S D | Swipe on the board, or use the on-screen arrow pad |
| Choose mode (start screen) | Left / Right, or 1 / 2 | Tap a mode |
| Pause / Resume | Space, P or Esc | Pause / Resume buttons |
| Restart | Restart button | Restart button |
| Play / Play Again | Enter (or the buttons) | Buttons |

The snake cannot turn straight back into itself. Up to **four** quick turns are buffered, so fast key presses never skip a turn or cause a glitch, and the snake's eyes turn towards your next buffered turn straight away. The page does not scroll while you play, and the game pauses automatically if you switch to another tab.

Your **highest scores** are saved in your browser (`localStorage`) and survive a refresh. To reset them, clear the site data for the page, or run `localStorage.removeItem('numberSnake.highScore')` (Normal) and `localStorage.removeItem('numberSnake.highScore.nowalls')` (No walls) in the browser console.

## Project structure

```
number-snake/
  index.html   page structure: header, stats, board and screens (start, pause, game over), touch pad, rules
  style.css    dark gaming theme, responsive layout, animations
  script.js    game logic (pure functions) + canvas rendering, input and screens
  README.md    this file
```

No `assets/` folder is needed: everything is drawn with CSS and canvas.

## Customising

Open `script.js` and edit the constants at the top.

| Constant | Meaning | Default |
| --- | --- | --- |
| `COLS`, `ROWS` | Board size in cells | 24 x 24 |
| `MAX_QUEUE` | Quick turns that can be buffered | 4 |
| `MODES.<mode>.levelEvery` | Points needed per level | 5 (Normal), 3 (No walls) |
| `MODES.<mode>.startInterval` | Milliseconds per move at level 1 | 150 / 140 |
| `MODES.<mode>.intervalStep` | Milliseconds faster per level | 10 / 12 |
| `MODES.<mode>.minInterval` | Fastest allowed move interval | 70 / 60 |
| `MODES.<mode>.growth` | Segments gained per number | 1 / 2 |
| `MODES.<mode>.freezeLevel` | Speed level the stopwatch holds the game at | 2 |
| `FREEZE_MS`, `SHIELD_MS` | Stopwatch and plus durations | 35000, 12000 |
| `ITEM_LIFE` | How long each item stays on the board | bomb 9 s, others 12 s |
| `SPAWN_MIN`, `SPAWN_MAX` | Gap between spawns | 5000, 9000 |
| `MAX_BOMBS`, `BOMB_MIN_SCORE`, `BOMB_SAFE_DIST` | Bomb limits | 2, 3, 4 |
| `RANKS` | Rank names, minimum score and colour | Rookie to Legend |
| `CERT_MIN_SCORE` | Score needed to unlock the certificate | 50 |
| `WEIGHTS` | How likely each item type is | 3 / 3 / 3 |

Colours live in the `:root` block of `style.css` and in the `COLORS` object in `script.js`.

## Notes

- If you fill every cell of the board, you win (a very long run!).
- The power-up logic (`advance`, `spawnItem`, `step`) lives in the pure-logic half of `script.js`, so it can be unit tested in Node without a browser.
- `script.js` also exports its logic functions when loaded in Node.js (`require('./script.js')`), which is handy for unit tests.
- In the browser console, `NumberSnake.getState()` returns a read-only snapshot of the current game (mode, score, snake cells, food, items on the board, active effects and so on) for debugging.