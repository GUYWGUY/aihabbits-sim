# Project links

Everything you need to run, monitor and pay for the two studies.

## Live study URLs (Connect "Project Link")

| Study | URL | Connect project |
|---|---|---|
| 1 — Social Norms (no timing) | https://aihabbits-sim.vercel.app/social | `D8C0223B7E` |
| 2 — Real-Pace (with timing) | https://aihabbits-sim.vercel.app/realtime | `570B52049B` |
| Landing page (not a study target) | https://aihabbits-sim.vercel.app/ | — |

Local testing without a participant id: append `?dev=1` to either study URL.

## Data

| What | Where |
|---|---|
| **Tracking sheet** (one row per session — export as CSV for bonuses) | https://docs.google.com/spreadsheets/d/1ZqCnaDjdi_Jjlh3aeBzt0om9CWRUlBgR25HrA5vwnPM/edit — tab **`sessions`** |
| Full session JSON (trajectories), private | Vercel → Storage → `aihabbits-sim-blob` → Manage Blobs: https://vercel.com/guy-wachtels-projects/aihabbits-sim/stores/blob/store_erzEbZ9rE0DMv0mN |
| The Apps Script behind the sheet | Open the sheet → Extensions → Apps Script (source: `scripts/sheets-webhook.gs`) |

Paying bonuses: download the sheet as CSV, keep `participant_id` + `duration_total_sec`
(or `final_score`), then Connect → Manage Participants → Upload CSV.

## Vercel

| What | URL |
|---|---|
| Project overview | https://vercel.com/guy-wachtels-projects/aihabbits-sim |
| Deployments | https://vercel.com/guy-wachtels-projects/aihabbits-sim/deployments |
| Environment variables | https://vercel.com/guy-wachtels-projects/aihabbits-sim/settings/environment-variables |
| Runtime logs (`/api/submit` errors show here) | https://vercel.com/guy-wachtels-projects/aihabbits-sim/logs |

## Code

| What | URL |
|---|---|
| GitHub repo (push to `main` = deploy) | https://github.com/GUYWGUY/aihabbits-sim |
| Connect (researcher dashboard) | https://connect.cloudresearch.com/ |
