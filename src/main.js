import { CONFIG } from './config.js';
import {
  connect,
  submitSession,
  beaconAbandon,
  markGameStart,
  timingSnapshot,
  completionRedirectUrl,
  goToConnect,
} from './platform.js';
import { audio } from './audio.js';
import { TrajectoryLogger } from './trajectory.js';
import { GameState } from './gameState.js';
import { World } from './world.js';
import { EventEngine } from './events.js';
import { UI } from './ui.js';

// ============================================================================
// Glue layer: wires Three.js world, abstract game state, event engine and HUD
// together; runs the master tick loop and the rAF render loop.
//
// This module no longer self-starts. Each experiment has its own page and its
// own entry file (entry-realtime.js / entry-social.js) which calls boot() with
// the one mode that page runs. See EXPERIMENTS below.
// ============================================================================

// Per-experiment presentation copy. The gameplay difference itself lives in
// gameState.js / events.js, keyed off GameState.gameMode.
export const EXPERIMENTS = {
  REALTIME: {
    mode: 'REALTIME',
    id: 'realtime',
    name: 'Real-Pace Simulation',
    subtitle: 'Real-pace 3D simulation · CloudResearch Connect',
  },
  SOCIAL_NORMS: {
    mode: 'SOCIAL_NORMS',
    id: 'social-norms',
    name: 'Social Norms',
    subtitle: 'Social norms · no time pressure · CloudResearch Connect',
  },
};

let experiment = EXPERIMENTS.REALTIME;
let world = null;
let gs = null;
let traj = null;
let ui = null;

let lastFrameMs = performance.now();
let tickAccumulatorMs = 0;
let secondAccumulatorMs = 0;
let eventEngine = null;
let started = false;
let scanItemAccumulatorMs = 0;
let loopCrashed = false;

// Outcome of the automatic save that runs the moment the session ends.
const saveState = { attempted: false, endReason: null };

/**
 * Boot one experiment. Called exactly once, by the page's entry module.
 * @param {'REALTIME'|'SOCIAL_NORMS'} mode
 */
export function boot(mode) {
  experiment = EXPERIMENTS[mode];
  if (!experiment) throw new Error(`boot(): unknown experiment mode "${mode}"`);

  // Background bed: store ambience + light music. Served from public/audio
  // (Vite copies it next to the bundles), started on the Start click because
  // browsers refuse audio without a user gesture.
  audio.init({ ambienceUrl: '/audio/ambience.mp3', musicUrl: '/audio/music.mp3' });

  const canvas = document.getElementById('bg-canvas');
  world = new World(canvas);
  gs = new GameState();
  traj = new TrajectoryLogger();

  ui = new UI({
    world,
    experiment,
    onStart: startGame,
    onRetrySave: saveSession,
    onDownload: handleDownload,
    onFinish: () => goToConnect(experiment.id),
  });

  // A participant who closes the tab mid-session still tells us something:
  // record the drop-out so "started but never finished" is distinguishable
  // from "never started".
  window.addEventListener('pagehide', () => {
    if (!started || gs.finished || saveState.attempted) return;
    beaconAbandon({
      experimentId: experiment.id,
      finalScore: Math.round(gs.points),
      trajectory: traj.export(),
      metadata: buildMetadata(),
    });
  });

  // Initialize the queue immediately on load so characters are visible behind the intro
  gs.buildInitialQueue();
  world.syncQueue(gs.queue);

  lastFrameMs = performance.now();

  // kick off the render loop immediately so the scene is live behind the intro
  animate();
}

function animate() {
  if (loopCrashed) return;
  requestAnimationFrame(animate);
  const now = performance.now();
  const dtMs = now - lastFrameMs;
  lastFrameMs = now;
  const dtSec = dtMs / 1000;

  try {
    if (started && !gs.finished) {
      tickAccumulatorMs += dtMs;
      while (tickAccumulatorMs >= CONFIG.TICK_MS) {
        gameTick(CONFIG.TICK_MS);
        tickAccumulatorMs -= CONFIG.TICK_MS;
      }
    }

    // visual scan items spawn while a customer is being scanned
    if (started && !gs.finished && gs.cashierProgressMs > 0) {
      scanItemAccumulatorMs += dtMs * gs.cashierRate();   // belt slows with the cashier
      if (scanItemAccumulatorMs > 2200) {
        world.spawnScanItem();
        scanItemAccumulatorMs = 0;
      }
    }

    world.update(dtSec);
    ui.updateAnchors(dtMs);
    world.render();
  } catch (err) {
    loopCrashed = true;
    console.error("CRASH IN ANIMATE LOOP:", err);
    ui.log("⚠️ CRASH IN RENDERING LOOP: " + (err.stack || err.message), "bad");
  }
}

// ----------------------------------------------------------------------------
// Game tick: bleeds points, advances the cashier, fires event checks, logs
// idle-wait trajectory entries every second.
// ----------------------------------------------------------------------------
function gameTick(dtMs) {
  gs.elapsedMs += dtMs;
  gs.elapsedSec = gs.elapsedMs / 1000;

  // safety cap
  if (gs.gameMode !== 'SOCIAL_NORMS' && gs.elapsedSec >= CONFIG.MAX_DURATION_S) {
    endGame('TIMEOUT');
    return;
  }

  gs.bleedPoints(dtMs);

  const adv = gs.advanceCashier(dtMs);
  if (adv.customerFinished) {
    if (adv.customerObj.isPlayer) {
      endGame('CHECKOUT_COMPLETE');
      return;
    }
    // sync world: during an active event freeze the affected section of the
    // queue so only characters ahead of the blockage advance.
    // DROP: freeze from the dropper's position (they block their own spot).
    // Other events: freeze from the player's position.
    let frozenFromIdx = Infinity;
    if (gs.activeEvent) {
      if (gs.activeEvent.type === 'DROP') {
        const dropperIdx = gs.queue.findIndex(n => n.id === gs.activeEvent.npc.id);
        frozenFromIdx = dropperIdx >= 0 ? dropperIdx : Infinity;
      } else if (gs.activeEvent.type === 'ISRAELI_QUEUE') {
        const friendIdx = gs.queue.findIndex(n => n.id === gs.activeEvent.friend.id);
        frozenFromIdx = friendIdx >= 0 ? friendIdx : gs.playerIndex();
      } else {
        frozenFromIdx = gs.playerIndex();
      }
    }
    world.syncQueue(gs.queue, frozenFromIdx);
    gs.startNextCustomerAtCashier();
  }

  eventEngine.maybeTrigger();

  // periodic per-second IDLE_WAIT logging when nothing is happening
  secondAccumulatorMs += dtMs;
  if (secondAccumulatorMs >= 1000) {
    secondAccumulatorMs -= 1000;
    if (!gs.activeEvent) {
      const prev = gs.snapshotState();
      // snapshot is functionally identical except for time + points
      traj.record({
        t: gs.elapsedSec,
        state: prev,
        action: 'IDLE_WAIT',
        points: gs.points,
        nextState: gs.snapshotState(),
      });
    }
  }

  // refresh stats
  ui.updateStats({
    score: gs.points,
    time: gs.elapsedSec,
    position: gs.playerPosition(),
    qlen: gs.queue.length,
    cashPct: gs.cashierProgressPct(),
    decisions: gs.decisionsCount,
    gameMode: gs.gameMode,
    eventsCount: gs.eventsCount,
  });

}

// ----------------------------------------------------------------------------
// Event resolution → trajectory recorder
// ----------------------------------------------------------------------------
function recordEventAction(action, prevState, points, immediatePenalty) {
  traj.record({
    t: gs.elapsedSec,
    state: prevState,
    action,
    points,
    nextState: gs.snapshotState(),
    immediatePenalty,
  });
}

// ----------------------------------------------------------------------------
function generateEventSequence(length) {
  const sequence = [];
  const types = ['DROP', 'CUTTER', 'ISRAELI_QUEUE'];
  let lastType = null;
  const counts = { DROP: 0, CUTTER: 0, ISRAELI_QUEUE: 0 };
  const targetCount = Math.ceil(length / 3);

  for (let i = 0; i < length; i++) {
    let candidates = types.filter(t => counts[t] < targetCount && t !== lastType);
    if (candidates.length === 0) {
      candidates = types.filter(t => t !== lastType);
    }
    if (candidates.length === 0) {
      candidates = types;
    }
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    sequence.push(chosen);
    counts[chosen]++;
    lastType = chosen;
  }
  return sequence;
}

// ----------------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------------
function startGame(mode = experiment.mode) {
  gs.gameMode = mode;
  // Reset game state statistics but keep the queue that was built on load
  gs.points = CONFIG.INITIAL_POINTS;
  gs.elapsedMs = 0;
  gs.elapsedSec = 0;
  gs.eventsCount = 0;
  gs.decisionsCount = 0;
  gs.finished = false;
  gs.activeEvent = null;
  traj.init(CONFIG.INITIAL_POINTS);

  gs.startNextCustomerAtCashier();
  gs.initialInFront = gs.playerIndex();
  if (gs.gameMode === 'SOCIAL_NORMS') {
    gs.eventSequence = generateEventSequence(20);
  }

  eventEngine = new EventEngine({
    gameState: gs,
    world,
    ui,
    onAction: recordEventAction,
    onEndGame: endGame,
  });

  ui.renderDefaultActions();

  // Dev-only handle so a specific event/branch can be forced from the console
  // (e.g. __sim.events.triggerIsraeliQueue()) instead of waiting for the RNG.
  if (connect.devMode) {
    window.__sim = { gs, world, ui, traj, events: eventEngine, endGame, audio };
  }

  if (gs.gameMode === 'SOCIAL_NORMS') {
    ui.log(`🛒 Experiment started. There is no timer — take your time on each scenario.`, 'good');
  } else {
    ui.log(`🛒 Simulation started. You're #${gs.playerPosition()} in line. Good luck!`, 'good');
  }

  // initial INIT trajectory entry
  traj.record({
    t: 0,
    state: gs.snapshotState(),
    action: 'INIT',
    points: gs.points,
    nextState: gs.snapshotState(),
  });

  started = true;
  markGameStart();
  audio.start();

  if (gs.gameMode === 'SOCIAL_NORMS') {
    setTimeout(() => {
      eventEngine.triggerRandomEvent();
    }, 1500);
  }
}

function endGame(reason) {
  if (gs.finished) return;
  gs.finished = true;
  world.cashierAttentionReset?.();
  audio.stop({ fadeMs: 1500 });

  // final transition
  const prev = gs.snapshotState();
  traj.record({
    t: gs.elapsedSec,
    state: prev,
    action: reason,
    points: gs.points,
    nextState: {
      queue_length: 0,
      player_position: 0,
      current_event: 'TERMINAL',
      npc_involved: null,
      time_elapsed: Math.round(gs.elapsedSec),
      points: Math.round(gs.points),
      cashier_progress_pct: 100,
    },
  });

  if (reason === 'COMPLETED_SOCIAL_NORMS') {
    ui.log(`🏁 Experiment complete! All scenarios resolved.`, 'good');
  } else {
    ui.log(`🏁 ${reason === 'TIMEOUT' ? 'Time cap reached.' : 'Checkout complete!'}`, 'good');
  }

  const timing = timingSnapshot();

  ui.showEndScreen({
    finalScore: Math.round(gs.points),
    totalTimeSec: gs.elapsedSec,
    durationTotalSec: timing.duration_total_sec,
    decisions: gs.decisionsCount,
    events: gs.eventsCount,
    trajLen: traj.entries.length,
    gameMode: gs.gameMode,
    hasRedirect: !!completionRedirectUrl(experiment.id),
  });

  // The participant never presses "submit" — the session saves itself the
  // moment it ends, and only then are they offered the way back to Connect.
  saveState.endReason = reason;
  saveSession();
}

// ----------------------------------------------------------------------------
// Persistence (api/submit.js → Vercel Blob + tracking spreadsheet)
// ----------------------------------------------------------------------------
function buildMetadata() {
  return {
    participant_id: connect.participantId,
    assignment_id: connect.assignmentId,
    project_id: connect.projectId,
    session_id: connect.sessionId,
    schema_version: '2.0',
    platform: 'cloudresearch-connect',
    experiment_id: experiment.id,
    experiment_mode: gs.gameMode,
    page_url: window.location.href,
    config: CONFIG,
    decisions_count: gs.decisionsCount,
    events_count: gs.eventsCount,
    total_time_sec: +gs.elapsedSec.toFixed(2),
    user_agent: navigator.userAgent,
    submitted_at_iso: new Date().toISOString(),
  };
}

async function saveSession() {
  saveState.attempted = true;
  ui.setSaveStatus('saving');

  const result = await submitSession({
    experimentId: experiment.id,
    endReason: saveState.endReason,
    completed: saveState.endReason !== 'ABANDONED',
    finalScore: Math.round(gs.points),
    trajectory: traj.export(),
    metadata: buildMetadata(),
  });

  if (result.ok) {
    ui.setSaveStatus(result.skipped ? 'dev' : 'saved');
    // Auto-return to Connect so the participant collects their completion code
    // without having to do anything. The button stays as a manual fallback.
    if (!result.skipped && completionRedirectUrl(experiment.id)) {
      ui.startRedirectCountdown(() => goToConnect(experiment.id));
    }
  } else {
    ui.setSaveStatus('failed', result.error);
  }
  return result;
}

function handleDownload() {
  const payload = {
    ...buildMetadata(),
    end_reason: saveState.endReason,
    timing: timingSnapshot(),
    final_score: Math.round(gs.points),
    trajectory: traj.export(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trajectory_${experiment.id}_${connect.participantId || 'dev'}_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
