import { CONFIG } from './config.js';

// ============================================================================
// NPC profile templates. Age × State combinations matter for cultural norms.
// ============================================================================
const TEMPLATES = [
  { age: 'Adult',   state: 'Standard',   label: 'Adult',          weight: 6 },
  { age: 'Adult',   state: 'BusyParent', label: 'Parent',         weight: 2 },
  { age: 'Elderly', state: 'Standard',   label: 'Elderly',        weight: 3 },
  { age: 'Youth',   state: 'Standard',   label: 'Youth',          weight: 2 },
  { age: 'Adult',   state: 'Pregnant',   label: 'Pregnant Adult', weight: 1 },
  { age: 'Adult',   state: 'Disabled',   label: 'Disabled Adult', weight: 1 },
];

function weightedPick(arr) {
  const total = arr.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of arr) { r -= x.weight; if (r <= 0) return x; }
  return arr[arr.length - 1];
}

export function makeNPC() {
  const t = weightedPick(TEMPLATES);
  // ~50/50 male/female (Pregnant always F).
  const gender = (t.state === 'Pregnant') ? 'F' : (Math.random() < 0.5 ? 'M' : 'F');
  return {
    id: 'npc_' + Math.random().toString(36).slice(2, 10),
    age: t.age,
    state: t.state,
    label: t.label,
    gender,
    isPlayer: false,
  };
}

export function makePlayer() {
  return {
    id: 'PLAYER',
    age: 'Adult',
    state: 'Standard',
    label: 'YOU',
    gender: Math.random() < 0.5 ? 'M' : 'F',
    isPlayer: true,
  };
}

// Box-Muller normal sampler (clamped to a positive minimum).
function gaussian(mean, sd, min = 0.5) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(min, mean + z * sd);
}

function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

// ============================================================================
// GameState: queue, cashier, points, time. UI-agnostic (no DOM, no Three.js).
// ============================================================================
export class GameState {
  constructor() {
    this.queue = [];        // index 0 = at cashier, last = back of line
    this.points = CONFIG.INITIAL_POINTS;
    this.elapsedMs = 0;
    this.elapsedSec = 0;

    // current customer at cashier
    this.cashierTotalMs = 0;
    this.cashierProgressMs = 0;
    this.cashierExtraMs = 0;     // delays added by player actions

    this.activeEvent = null;
    this.eventsCount = 0;
    this.decisionsCount = 0;
    this.finished = false;
  }

  buildInitialQueue() {
    const inFront = randInt(
      CONFIG.INITIAL_QUEUE_LEN_RANGE[0],
      CONFIG.INITIAL_QUEUE_LEN_RANGE[1]
    );
    this.queue = [];
    for (let i = 0; i < inFront; i++) this.queue.push(makeNPC());
    this.queue.push(makePlayer());
    for (let i = 0; i < CONFIG.EXTRA_NPCS_BEHIND; i++) this.queue.push(makeNPC());
  }

  startNextCustomerAtCashier() {
    if (this.queue.length === 0) return;
    this.cashierTotalMs =
      gaussian(CONFIG.CASHIER_MEAN_S, CONFIG.CASHIER_SD_S, CONFIG.CASHIER_MIN_S) * 1000;
    this.cashierProgressMs = 0;
    this.cashierExtraMs = 0;
  }

  /** Returns { customerFinished, customerObj } when a customer completes checkout. */
  advanceCashier(dtMs) {
    if (this.activeEvent && this.activeEvent.blocksCheckout) {
      return { customerFinished: false };
    }
    this.cashierProgressMs += dtMs;
    const total = this.cashierTotalMs + this.cashierExtraMs;
    if (this.cashierProgressMs < total) return { customerFinished: false };

    const finished = this.queue.shift();
    return { customerFinished: true, customerObj: finished };
  }

  cashierProgressPct() {
    const total = Math.max(1, this.cashierTotalMs + this.cashierExtraMs);
    return Math.min(100, (this.cashierProgressMs / total) * 100);
  }

  playerIndex() {
    return this.queue.findIndex((n) => n.isPlayer);
  }

  /** 1 = at cashier, etc. -1 if player not in queue. */
  playerPosition() {
    const idx = this.playerIndex();
    return idx === -1 ? -1 : idx + 1;
  }

  isPlayerAtCashier() {
    return this.playerIndex() === 0;
  }

  bleedPoints(dtMs) {
    this.points -= (CONFIG.TIME_PENALTY_PER_SEC * dtMs) / 1000;
    if (this.points < 0) this.points = 0;
  }

  /** Used by events to delay the current cashier without bumping the queue order. */
  addCashierDelay(seconds) {
    this.cashierExtraMs += seconds * 1000;
  }

  insertCutterInFrontOfPlayer(cutter) {
    const idx = this.playerIndex();
    if (idx <= 0) return false;
    this.queue.splice(idx, 0, cutter);
    return true;
  }

  insertFriendInFrontOfPlayer(friend) {
    const idx = this.playerIndex();
    if (idx <= 0) return false;
    this.queue.splice(idx, 0, friend);
    return true;
  }

  removeById(id) {
    const idx = this.queue.findIndex((n) => n.id === id);
    if (idx >= 0) this.queue.splice(idx, 1);
    return idx;
  }

  sendToBack(npc) {
    this.removeById(npc.id);
    this.queue.push(npc);
  }

  snapshotState() {
    const ev = this.activeEvent;
    return {
      queue_length: this.queue.length,
      player_position: this.playerPosition(),
      current_event: ev ? ev.type : null,
      npc_involved: ev && ev.npc
        ? { id: ev.npc.id, age: ev.npc.age, state: ev.npc.state, label: ev.npc.label }
        : null,
      time_elapsed: Math.round(this.elapsedSec),
      points: Math.round(this.points),
      cashier_progress_pct: Math.round(this.cashierProgressPct()),
    };
  }
}
