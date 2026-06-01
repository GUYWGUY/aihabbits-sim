import { CONFIG } from './config.js';
import { mturk, submitToMTurk } from './mturk.js';
import { TrajectoryLogger } from './trajectory.js';
import { GameState } from './gameState.js';
import { World } from './world.js';
import { EventEngine } from './events.js';
import { UI } from './ui.js';

// ============================================================================
// Glue layer: wires Three.js world, abstract game state, event engine and HUD
// together; runs the master tick loop and the rAF render loop.
// ============================================================================

const canvas = document.getElementById('bg-canvas');
const world = new World(canvas);
const gs = new GameState();
const traj = new TrajectoryLogger();

let lastFrameMs = performance.now();
let tickAccumulatorMs = 0;
let secondAccumulatorMs = 0;
let eventEngine = null;
let started = false;
let scanItemAccumulatorMs = 0;

const ui = new UI({
  world,
  onStart: startGame,
  onSubmit: handleSubmit,
  onDownload: handleDownload,
});

// Initialize the queue immediately on load so characters are visible behind the intro
gs.buildInitialQueue();
world.syncQueue(gs.queue);

let loopCrashed = false;

// kick off the render loop immediately so the scene is live behind the intro
animate();

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
      scanItemAccumulatorMs += dtMs;
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
  if (gs.elapsedSec >= CONFIG.MAX_DURATION_S) {
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
  });

  if (gs.points <= 100 && Math.random() < 0.02) ui.flashScore();
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
// Lifecycle
// ----------------------------------------------------------------------------
function startGame() {
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

  eventEngine = new EventEngine({
    gameState: gs,
    world,
    ui,
    onAction: recordEventAction,
  });

  ui.renderDefaultActions();
  ui.log(`🛒 Simulation started. You're #${gs.playerPosition()} in line. Good luck!`, 'good');

  // initial INIT trajectory entry
  traj.record({
    t: 0,
    state: gs.snapshotState(),
    action: 'INIT',
    points: gs.points,
    nextState: gs.snapshotState(),
  });

  started = true;
}

function endGame(reason) {
  if (gs.finished) return;
  gs.finished = true;

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

  ui.log(`🏁 ${reason === 'TIMEOUT' ? 'Time cap reached.' : 'Checkout complete!'}`, 'good');
  ui.showEndScreen({
    finalScore: Math.round(gs.points),
    totalTimeSec: gs.elapsedSec,
    decisions: gs.decisionsCount,
    events: gs.eventsCount,
    trajLen: traj.entries.length,
  });
}

// ----------------------------------------------------------------------------
// Submission / debug download
// ----------------------------------------------------------------------------
function buildMetadata() {
  return {
    assignmentId: mturk.assignmentId,
    workerId: mturk.workerId,
    hitId: mturk.hitId,
    schema_version: '1.0',
    config: CONFIG,
    decisions_count: gs.decisionsCount,
    events_count: gs.eventsCount,
    total_time_sec: +gs.elapsedSec.toFixed(2),
    user_agent: navigator.userAgent,
    submitted_at_iso: new Date().toISOString(),
  };
}

function handleSubmit() {
  const finalScore = Math.round(gs.points);
  const trajectory = traj.export();
  const metadata = buildMetadata();
  const ok = submitToMTurk({ finalScore, trajectory, metadata });
  if (!ok) {
    if (mturk.devMode) {
      alert('🛠️ Dev Mode: real MTurk submission is disabled.\n\nThe payload was logged to the console; use "Download trajectory" to save it.');
    } else if (mturk.isPreview) {
      alert('Preview mode — submission disabled. (You must accept the HIT first.)');
    }
  }
}

function handleDownload() {
  const payload = {
    ...buildMetadata(),
    final_score: Math.round(gs.points),
    trajectory: traj.export(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trajectory_${mturk.workerId || 'preview'}_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
