# Checkout Queue — 3D Behavioral Simulation

A real-time, real-pace 3D supermarket checkout simulation built for **CloudResearch Connect** behavioral data collection. The data is logged in standard RL `(state, action, reward, next_state)` tuples for downstream **Inverse Reinforcement Learning** / **Behavioral Cloning** training.

> Goal: train an AI agent on human cultural norms by collecting how real people respond to social pressure points in a queue (drops, line-cutters, group joiners).

---

## Two experiments, two URLs, one Vercel project

The two conditions are **separate experiments on separate URLs**. A participant never
sees a mode selector — the study they accepted decides which condition they get.

| # | URL | Experiment | What it is |
|---|---|---|---|
| 1 | `/social` | `SOCIAL_NORMS` | **No timing.** Norms in isolation: no timer, no point bleed, static cashier. 20 consecutive scenarios balanced across the three event types. |
| 2 | `/realtime` | `REALTIME` | **With timing.** Real-pace queue: time bleeds points (−1/sec), the cashier advances the line, random events roughly every 20s. Ends at the cashier (or the 10-minute cap). |
| — | `/` | — | Landing page linking to both. Not a study target. |

Connect studies: experiment 1 → project `D8C0223B7E`, experiment 2 → project `570B52049B`
(see [`src/connect.config.js`](src/connect.config.js)).

Each experiment builds to its own self-contained HTML file, so each one is a valid
Connect **Project Link** on its own. Every saved session carries `experiment_id`
(`realtime` / `social-norms`) and `experiment_mode`, so the two conditions stay
separable downstream.

---

## Project layout

```
.
├── index.html              landing page → links to both experiments (static, no 3D)
├── realtime.html           experiment 1 page → src/entry-realtime.js
├── social.html             experiment 2 page → src/entry-social.js
├── vercel.json             cleanUrls (/realtime, /social) + build settings
├── package.json            Vite build — one single-file bundle per page
├── vite.config.js          per-page build config (--mode landing|realtime|social)
├── README.md
├── api/
│   └── submit.js           serverless: session JSON → Vercel Blob + summary row → Sheets
├── scripts/
│   └── sheets-webhook.gs   Apps Script to paste into the tracking spreadsheet
└── src/
    ├── entry-realtime.js   boot('REALTIME')
    ├── entry-social.js     boot('SOCIAL_NORMS')
    ├── main.js             orchestrator + game loop; exports boot(mode) + EXPERIMENTS
    ├── config.js           tunables (timings, probabilities, points)
    ├── connect.config.js   ⚙️ per-study Connect Redirect URLs — edit per deployment
    ├── platform.js         Connect params, bonus timing, session save, redirect
    ├── styles.css          HUD + screens (glassmorphism, Inter font)
    ├── trajectory.js       RL trajectory logger (S, A, R, S')
    ├── gameState.js        queue + cashier + points + timing
    ├── world.js            Three.js scene: env, lights, characters, camera
    ├── events.js           event engine + DROP / CUTTER / ISRAELI_QUEUE
    └── ui.js               HUD, screens, action panel, narrative log, floating text
```

The gameplay difference between the experiments lives in `gameState.js` and
`events.js`, keyed off `GameState.gameMode`. The page only decides which mode
`boot()` starts in; there is one copy of the simulation.

---

## Run locally (no build needed)

The project uses **native ES modules + an importmap** for Three.js, so a static file server is enough.

Pick any of these from the project root:

```bash
# Python (usually pre-installed on Windows)
python -m http.server 8000

# Node, no install
npx serve . -p 8000

# VS Code: install the "Live Server" extension and click "Go Live"
```

Then open:

- <http://localhost:8000/realtime.html?dev=1> — real-pace experiment
- <http://localhost:8000/social.html?dev=1> — social-norms experiment
- <http://localhost:8000/> — landing page

`?dev=1` runs without a Connect `participantId` (and reveals the 3D character legend).
Saving is stubbed to a console dump in dev mode — `/api/submit` only exists on Vercel.

---

## Build single-file bundles

A Connect Project Link is a single URL, so each experiment is bundled into its own
fully self-contained HTML file (JS, CSS and three.js all inlined).

```bash
npm install
npm run build
# → dist/index.html      landing page      (~6 kB)
# → dist/realtime.html   experiment 1      (~590 kB)
# → dist/social.html     experiment 2      (~590 kB)
```

`vite-plugin-singlefile` supports only one entry point per build, so `npm run build`
runs Vite three times into the same `dist/` — only the first pass empties it.
Individual pages: `npm run build:realtime`, `npm run build:social`, `npm run build:landing`.

```bash
npm run preview   # local sanity check on the built artifacts (port 4173)
```

---

## Deploy (Vercel)

Both experiments ship as **one Vercel project**. `vercel.json` sets
`buildCommand`, `outputDirectory: dist`, and `cleanUrls: true` — the last one is
what turns `dist/realtime.html` into the clean `/realtime` URL. `api/submit.js` is
deployed as a serverless function from the same project.

```
https://<your-deployment>/realtime   → Project Link for Connect study 1
https://<your-deployment>/social     → Project Link for Connect study 2
https://<your-deployment>/api/submit → session sink (POST, internal)
```

`dist/` is generated on Vercel and is git-ignored.

---

## CloudResearch Connect integration

### 1. Identifying the participant

Connect appends its identifiers to the Project Link when it sends someone to us:

```
https://<deployment>/realtime?participantId=XXXX&assignmentId=YYYY&projectId=ZZZZ
```

`src/platform.js` reads them. `participantId` is required — without it the session
cannot be credited, so the start button is disabled and a notice explains that the
participant must open the study from Connect. `?dev=1` bypasses this for local testing
(and stubs saving to a console dump).

### 2. Timing for the bonus

Connect does not measure time on an external site, so we do it:

| Field | Meaning |
|---|---|
| `loaded_at_iso` | the simulation finished loading (start of the run) |
| `game_started_at_iso` | the participant pressed Start (excludes instruction-reading time) |
| `ended_at_iso` | the session ended |
| `duration_total_sec` | **load → end.** This is the span to pay the bonus on |
| `duration_game_sec` | start → end |

### 3. Saving the data

There is no platform-side submit endpoint, so the session POSTs to our own
`api/submit.js`, which writes to two places:

1. **Vercel Blob** — the complete session JSON including the full trajectory,
   at `sessions/<experiment_id>/<participantId>__<sessionId>__<endReason>.json`.
2. **Google Sheets** — one summary row per session (participant id, completed,
   score, both durations, decisions, events, link to the blob). Export this sheet
   as CSV for Connect → **Manage Participants → Upload CSV** to pay bonuses.

The save runs **automatically** when the session ends — the participant never presses
a submit button. The "Finish" button unlocks only once the data has landed; if both
sinks fail, the end screen offers a retry and a download as a fallback. A participant
who closes the tab mid-session is recorded via `navigator.sendBeacon` with
`end_reason: "ABANDONED"`, so drop-outs are distinguishable from no-shows.

Required environment variables (Vercel → Settings → Environment Variables):

| Variable | Where it comes from |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | set automatically when you connect a Vercel Blob store |
| `SHEETS_WEBHOOK_URL` | the `/exec` URL of the Apps Script in [`scripts/sheets-webhook.gs`](scripts/sheets-webhook.gs) |
| `SHEETS_WEBHOOK_SECRET` | any long random string; must match `SECRET` in that script |

Either sink may be missing — the function succeeds as long as one write lands, and
reports per-sink status in its response.

### 4. Returning to Connect

Each study's **Redirect URL** (from the last step of "Create a Study") is configured
in [`src/connect.config.js`](src/connect.config.js). After a successful save the end
screen counts down and sends the participant there to collect their completion code;
the button also works immediately. Leaving a URL empty disables the redirect.

---

## RL formalization

Each timestep entry has the schema:

```jsonc
{
  "t": 12.34,
  "state": {
    "queue_length": 8,
    "player_position": 5,           // 1 = at cashier
    "current_event": "CUTTER",      // or null
    "npc_involved": { "id": "...", "age": "Adult", "state": "Aggressive", "label": "..." },
    "time_elapsed": 12,
    "points": 988,
    "cashier_progress_pct": 34
  },
  "action": "ARGUE_WITH_CUTTER",
  "reward": -8,                     // points delta from previous record
  "immediate_action_penalty": 0,
  "next_state": { /* same schema */ }
}
```

Idle timesteps emit periodic `IDLE_WAIT` records so the time-bleed reward is captured even when no event is active.

---

## Tuning

All gameplay constants live in [`src/config.js`](src/config.js). Notable defaults:

| Parameter | Default | Note |
|---|---|---|
| `INITIAL_POINTS` | 1000 | endowment |
| `TIME_PENALTY_PER_SEC` | 1 | bleed rate |
| `CASHIER_MEAN_S` / `CASHIER_SD_S` | 30 / 8 | normal-distributed scan time |
| `INITIAL_QUEUE_LEN_RANGE` | [7, 9] | NPCs in front of player |
| `EXTRA_NPCS_BEHIND` | 3 | cosmetic queue length |
| `EVENT_CHECK_S` / `EVENT_PROB` | 25 / 0.6 | spacing × probability ≈ 1 event / 30s |
| `MAX_DURATION_S` | 600 | hard 10-minute cap |

Designed-for session length: **~5 minutes typical, up to 10 minutes**.

---

## Asset upgrades (optional)

The 3D scene is procedural — characters and environment are built from Three.js primitives, lit by a configured PBR pipeline (ACES tone-mapping, soft shadows, hemisphere + key + spot lights). For Triple-A fidelity you can drop in:

- **Character GLBs** under `public/assets/characters/{adult,elderly,...}.glb` and load via `GLTFLoader` in [`src/world.js`](src/world.js).
- **PBR floor / wall textures** (albedo, normal, roughness) under `public/assets/textures/`.
- **HDRI environment map** (`public/assets/env/checkout.hdr`) loaded via `RGBELoader`.

Suggested generation prompts (for OpenAI Images / Gemini / etc.):

- Floor tile, top-down, 1024×1024, seamless, polished off-white linoleum with subtle grain, PBR albedo only.
- Stylized low-poly elderly woman, neutral pose, T-pose-friendly, supermarket clothing, glTF-ready.
- Stylized low-poly aggressive young adult man, casual clothing, neutral pose, 5k tris max.
- Supermarket back-wall poster, "FRESH MARKET" branding, warm color palette, subtle grain.

The loader hooks in `world.js` are stubbed with `// TODO: GLTFLoader hook` comments — drop the loader call there and the rest of the pipeline picks up the new mesh.
