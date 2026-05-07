# Checkout Queue — 3D Behavioral Simulation

A real-time, real-pace 3D supermarket checkout simulation built for **Amazon Mechanical Turk** behavioral data collection. The data is logged in standard RL `(state, action, reward, next_state)` tuples for downstream **Inverse Reinforcement Learning** / **Behavioral Cloning** training.

> Goal: train an AI agent on human cultural norms by collecting how real people respond to social pressure points in a queue (drops, line-cutters, group joiners).

---

## Project layout

```
.
├── index.html              entry point (loads importmap + main.js)
├── package.json            optional — Vite build for single-file deployment
├── vite.config.js          optional — bundles to one HTML for MTurk hosting
├── README.md
└── src/
    ├── main.js             orchestrator + game loop
    ├── config.js           tunables (timings, probabilities, points)
    ├── styles.css          HUD + screens (glassmorphism, Inter font)
    ├── mturk.js            URL param parsing, preview/dev mode, submission
    ├── trajectory.js       RL trajectory logger (S, A, R, S')
    ├── gameState.js        queue + cashier + points + timing
    ├── world.js            Three.js scene: env, lights, characters, camera
    ├── events.js           event engine + DROP / CUTTER / ISRAELI_QUEUE
    └── ui.js               HUD, screens, action panel, narrative log, floating text
```

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

Then open: <http://localhost:8000/>

To bypass the MTurk preview gate during development, append `?dev=1` to the URL.

---

## Build single-file bundle for MTurk (optional)

MTurk's **ExternalQuestion** loads one URL. The cleanest deployment is a single self-contained `dist/index.html` you can drop on S3 / Netlify / GitHub Pages.

```bash
npm install
npm run build
# → dist/index.html (everything inlined: JS, CSS, three.js)
```

Then:

```bash
npm run preview   # local sanity check on the built artifact
```

Upload `dist/index.html` to any HTTPS-served static host. Use that URL in your MTurk **ExternalQuestion** template.

---

## MTurk integration

The page reads from URL params:
- `assignmentId`, `workerId`, `hitId`
- `turkSubmitTo` — sandbox uses `https://workersandbox.mturk.com`, prod uses `https://www.mturk.com`

Behaviors:
- **Preview mode** (`assignmentId === "ASSIGNMENT_ID_NOT_AVAILABLE"`): start button disabled, shows the "you must accept the HIT" notice.
- **Dev mode** (`?dev=1` or button on preview screen): bypasses the gate; submission is stubbed to a console dump.
- **Submission**: hidden form `POST` to `${turkSubmitTo}/mturk/externalSubmit` with:
  - `assignmentId`, `workerId`, `hitId`
  - `final_score` (integer)
  - `rl_trajectory_log` (JSON string of all `{state, action, reward, next_state}` tuples)
  - `metadata` (JSON string of session info, config snapshot, user agent, etc.)

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
