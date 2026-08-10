// ============================================================================
// CloudResearch Connect integration.
//
// Connect appends its own identifiers to the Project Link when it sends a
// participant to us:
//
//   https://<deployment>/realtime?participantId=XXXX&assignmentId=YYYY&projectId=ZZZZ
//
// `participantId` is the one that matters — it is how a completed session is
// matched back to a person for approval and for the time-based bonus.
// `assignmentId` and `projectId` are optional and stored when present.
//
// Unlike MTurk there is no platform-side submit endpoint, so results are POSTed
// to our own serverless function (api/submit.js), which persists the full
// session JSON and appends a summary row to the tracking spreadsheet.
//
// Timing for the bonus is measured here, not by Connect: we stamp page load,
// game start and session end, and report the spans alongside the participant id.
// ============================================================================

import { redirectUrlFor } from './connect.config.js';

const params = new URLSearchParams(window.location.search);

function newSessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export const connect = {
  participantId: params.get('participantId') || '',
  assignmentId: params.get('assignmentId') || '',
  projectId: params.get('projectId') || '',
  // ?dev=1 lets us run the study locally without a Connect participant id.
  devMode: params.get('dev') === '1',
  sessionId: newSessionId(),

  // --- bonus timing ---
  loadedAtMs: Date.now(),               // simulation loaded ("start of run")
  loadedAtIso: new Date().toISOString(),
  gameStartedAtMs: null,                // participant pressed Start
  gameStartedAtIso: null,
};

// Without a participant id we cannot report back who finished, so the session
// cannot be paid for — the intro screen blocks the start button in that case.
connect.identified = !!connect.participantId || connect.devMode;

export function enableDevMode() {
  connect.devMode = true;
  connect.identified = true;
  // eslint-disable-next-line no-console
  console.log('[connect] Dev mode enabled — results are logged to the console, not saved.');
}

/** Called when the participant actually starts the simulation. */
export function markGameStart() {
  connect.gameStartedAtMs = Date.now();
  connect.gameStartedAtIso = new Date().toISOString();
}

export const SUBMIT_ENDPOINT = '/api/submit';

/** Wall-clock spans Connect's bonus is calculated from. */
export function timingSnapshot() {
  const endedAtMs = Date.now();
  return {
    loaded_at_iso: connect.loadedAtIso,
    game_started_at_iso: connect.gameStartedAtIso,
    ended_at_iso: new Date(endedAtMs).toISOString(),
    // load → end. This is the span the Connect guide asks for.
    duration_total_sec: +((endedAtMs - connect.loadedAtMs) / 1000).toFixed(2),
    // Start button → end, i.e. excluding time spent reading the instructions.
    duration_game_sec: connect.gameStartedAtMs
      ? +((endedAtMs - connect.gameStartedAtMs) / 1000).toFixed(2)
      : null,
  };
}

function buildPayload({ experimentId, endReason, completed, finalScore, trajectory, metadata }) {
  return {
    participant_id: connect.participantId,
    assignment_id: connect.assignmentId,
    project_id: connect.projectId,
    session_id: connect.sessionId,
    experiment_id: experimentId,
    end_reason: endReason,
    completed: !!completed,
    final_score: finalScore,
    timing: timingSnapshot(),
    trajectory,
    metadata,
  };
}

/**
 * Persist a finished session. Retries a few times before giving up so a single
 * network blip doesn't cost us a participant's data.
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string, data?: object}>}
 */
export async function submitSession(args) {
  const payload = buildPayload(args);

  if (connect.devMode) {
    // eslint-disable-next-line no-console
    console.log('[connect DEV] Would POST to', SUBMIT_ENDPOINT, payload);
    return { ok: true, skipped: true };
  }

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return { ok: true, data: await res.json().catch(() => ({})) };
      lastError = `HTTP ${res.status}`;
      // 4xx means the payload itself is bad — retrying won't help.
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1200));
  }
  return { ok: false, error: lastError };
}

/**
 * Best-effort "this participant left mid-session" record, sent with
 * navigator.sendBeacon so it survives the page being closed. Lets us tell a
 * drop-out apart from someone who never started.
 */
export function beaconAbandon(args) {
  if (connect.devMode || !navigator.sendBeacon) return;
  const payload = buildPayload({ ...args, completed: false, endReason: 'ABANDONED' });
  try {
    navigator.sendBeacon(
      SUBMIT_ENDPOINT,
      new Blob([JSON.stringify(payload)], { type: 'application/json' })
    );
  } catch {
    /* nothing useful to do if the browser is already tearing the page down */
  }
}

/** The Connect Redirect URL for this experiment ('' when not configured). */
export function completionRedirectUrl(experimentId) {
  return redirectUrlFor(experimentId);
}

/** Send the participant back to Connect to collect their completion code. */
export function goToConnect(experimentId) {
  const url = completionRedirectUrl(experimentId);
  if (!url) return false;
  window.location.href = url;
  return true;
}
