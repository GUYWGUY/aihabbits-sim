import * as THREE from 'three';
import { CONFIG } from './config.js';

// ============================================================================
// Event engine. Schedules and resolves the three scenario-bank events:
//   - DROP            (Service Interruption)         — items physically fall
//   - CUTTER          (Preemptive Queueing)          — line-cutter inserts
//   - ISRAELI_QUEUE   (Network / Batch Arrival)      — friend joins ahead
//
// Every player action has a *visible* consequence in the 3D scene in addition
// to the trajectory log + score impact.
// ============================================================================

// Box-Muller normal sample, clamped to a positive minimum. Used so event
// durations (especially arguments) feel naturally varied, not fixed.
function gaussian(mean, sd, min = 0.5) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(min, mean + z * sd);
}

export class EventEngine {
  /**
   * @param {object} args
   * @param {import('./gameState.js').GameState} args.gameState
   * @param {import('./world.js').World} args.world
   * @param {object} args.ui
   * @param {(action: string, prevState, points, immediatePenalty?) => void} args.onAction
   */
  constructor({ gameState, world, ui, onAction }) {
    this.gs = gameState;
    this.world = world;
    this.ui = ui;
    this.onAction = onAction;

    this.nextCheckSec = CONFIG.EVENT_FIRST_AT_S;
    this.activeDroppedItems = null;
  }

  maybeTrigger() {
    if (this.gs.activeEvent) {
      if (this.gs.elapsedSec - this.gs.activeEvent.startedAt >= 10) {
        const type = this.gs.activeEvent.type;
        if (type === 'DROP') this.resolveDrop('DO_NOTHING');
        else if (type === 'CUTTER') this.resolveCutter('LET_IT_GO');
        else if (type === 'ISRAELI_QUEUE') this.resolveIsraeliQueue('WAIT');
      }
      return;
    }
    if (this.gs.elapsedSec < this.nextCheckSec) return;
    this.nextCheckSec =
      this.gs.elapsedSec + CONFIG.EVENT_CHECK_S + Math.random() * CONFIG.EVENT_CHECK_JITTER_S;

    if (this.gs.eventsCount >= CONFIG.MAX_EVENTS) return;
    if (this.gs.isPlayerAtCashier()) return;
    if (this.gs.playerPosition() <= 1) return;
    if (Math.random() > CONFIG.EVENT_PROB) return;

    const choices = ['DROP', 'CUTTER', 'ISRAELI_QUEUE'];
    const t = choices[Math.floor(Math.random() * choices.length)];
    if (t === 'DROP') this.triggerDrop();
    else if (t === 'CUTTER') this.triggerCutter();
    else this.triggerIsraeliQueue();
  }

  // =======================================================================
  // Event A — The Drop. Can happen to ANY non-player customer in the queue,
  // not just the one at the cashier. Helping a far-back person tests the
  // pro-social norm independently of pure self-interest.
  // =======================================================================
  triggerDrop() {
    const candidates = this.gs.queue.filter((n) => !n.isPlayer);
    if (candidates.length === 0) return;
    const at = candidates[Math.floor(Math.random() * candidates.length)];
    const dropperIdx = this.gs.queue.indexOf(at);
    const isAtCashier = (dropperIdx === 0);
    this.gs.eventsCount++;

    const where = isAtCashier
      ? 'at the cashier'
      : (dropperIdx === this.gs.playerIndex() - 1
          ? 'right in front of you'
          : `a few places ahead in line`);
    let flavor;
    if (at.age === 'Elderly') {
      flavor = `An elderly person ${where} dropped their groceries.`;
    } else if (at.age === 'Youth') {
      flavor = `A young customer ${where} fumbled and dropped their items.`;
    } else if (at.state === 'Pregnant') {
      flavor = `A pregnant woman ${where} dropped her groceries.`;
    } else {
      flavor = `A customer ${where} dropped their groceries.`;
    }

    this.gs.activeEvent = {
      type: 'DROP',
      npc: at,
      blocksCheckout: isAtCashier,         // only blocks the queue if dropper is at front
      isAtCashier,
      startedAt: this.gs.elapsedSec,
      options: [
        { key: 'HELP',       label: '🤝 Help pick up',  style: 'success' },
        { key: 'COMPLAIN',   label: '😤 Complain',      style: 'warn' },
        { key: 'DO_NOTHING', label: '😶 Do nothing',    style: 'ghost' },
      ],
    };

    this.activeDroppedItems = this.world.dropGroceriesAt(at.id, 5);
    this.world.gestureCharacter(at.id, 'slump', 1500);
    this.world.setEmotion(at.id, 'shocked');
    this.world.setEmotion('PLAYER', 'surprised');
    if (isAtCashier) {
      this.world.setCashierEmotion('shocked');
      setTimeout(() => this.world.setCashierEmotion('neutral'), 4000);
    }

    this.ui.banner(`⚠️ ${flavor} ${isAtCashier ? 'The line has stopped.' : ''}`);
    this.ui.log(flavor + ' Items are scattered on the floor.', 'warn');
    this.ui.speech(at.id, 'Oh no!');
    this.ui.renderActions(this.gs.activeEvent.options, (key) => this.resolveDrop(key));
    this.world.triggerUrgentShake();
  }

  resolveDrop(action) {
    if (!this.gs.activeEvent) return;
    const prevState = this.gs.snapshotState();
    const customer = this.gs.activeEvent.npc;
    const isAtCashier = !!this.gs.activeEvent.isAtCashier;
    const items = this.activeDroppedItems || [];
    let delaySec, logKind, msg;

    if (action === 'HELP') {
      delaySec = CONFIG.HELP_DELAY_S;
      logKind = 'good';
      msg = `✋ You helped pick everything up. (-${delaySec}s wait${isAtCashier ? '' : ', no cashier delay'})`;

      // VISUAL: walk to the dropper's actual location (not a fixed drop site),
      // kneel through the entire pickup, then walk back to the (possibly
      // updated) queue spot.
      const dropperPos = this.world.getCharacterPos(customer.id);
      const playerStart = this.world.getCharacterPos('PLAYER');
      let walkS = 1.2;
      let helperPos;
      if (dropperPos && playerStart) {
        helperPos = new THREE.Vector3(dropperPos.x + 0.55, 0, dropperPos.z + 0.45);
        // ~0.45s per metre of walk distance, clamped 1.0–2.6s
        const dist = playerStart.distanceTo(helperPos);
        walkS = Math.max(1.0, Math.min(2.6, dist * 0.45));
      } else {
        helperPos = this.world.getDropSitePos();
      }

      this.world.setEmotion('PLAYER', 'neutral');
      this.world.playScript('PLAYER', [
        { target: helperPos, durationS: walkS },
      ], () => {
        // Player kneels for the entire pickup duration.
        const totalRecoverMs = this.world.recoverItemsToNpc(items, customer.id, 1100, 1300);
        this.world.gestureCharacter('PLAYER', 'kneel', totalRecoverMs);
        // Customer recovers emotion partway through.
        setTimeout(() => this.world.setEmotion(customer.id, 'happy'), totalRecoverMs * 0.55);
        // Walk back to current queue position once items are all returned.
        setTimeout(() => {
          const idx = this.gs.playerIndex();
          if (idx < 0) return;
          const back = this.world.queuePosition(idx);
          this.world.playScript('PLAYER', [{ target: back, durationS: walkS }]);
        }, totalRecoverMs);
      });
    } else if (action === 'COMPLAIN') {
      delaySec = CONFIG.COMPLAIN_DELAY_S;
      logKind = 'warn';
      msg = `📢 You complained loudly. (-${delaySec}s${isAtCashier ? '' : ', no cashier delay'})`;

      this.world.setEmotion('PLAYER', 'angry');
      this.world.setEmotion(customer.id, 'sad');
      this.world.gestureCharacter('PLAYER', 'shake', 1500);
      this.ui.speech('PLAYER', 'Oh come on!');
      setTimeout(() => {
        this.world.gestureCharacter(customer.id, 'kneel', 5000);
        this.world.recoverItemsToNpc(items, customer.id, 1300, 1100);
      }, 800);
    } else {
      delaySec = CONFIG.DO_NOTHING_DELAY_S;
      logKind = 'info';
      msg = `😶 You waited silently while the customer recovered. (-${delaySec}s)`;

      this.world.setEmotion('PLAYER', 'neutral');
      this.world.setEmotion(customer.id, 'sad');
      setTimeout(() => {
        this.world.gestureCharacter(customer.id, 'kneel', 9000);
        this.world.recoverItemsToNpc(items, customer.id, 2100, 1400);
      }, 1000);
    }

    // The cashier-delay penalty only applies when the drop is actually
    // holding up the cashier (i.e., the dropper is at idx 0). Otherwise
    // the cost is just the player's time-bleed during the visual.
    if (isAtCashier) {
      this.gs.addCashierDelay(delaySec);
    }
    this.ui.log(msg, logKind);
    this.activeDroppedItems = null;
    this._finishEvent(action, prevState);
  }

  // =======================================================================
  // Event B — The Cutter. Argument has variable duration sampled from a
  // gaussian; the cashier keeps processing during the argument; player and
  // cutter "freeze in place" while the rest of the queue advances; once the
  // argument ends they catch up to the now-shorter queue.
  // =======================================================================
  triggerCutter() {
    const playerIdx = this.gs.playerIndex();
    if (playerIdx <= 0) return;
    this.gs.eventsCount++;

    const aggressive = Math.random() < 0.5;
    const cutter = {
      id: 'cut_' + Math.random().toString(36).slice(2, 10),
      age: aggressive ? 'Adult' : 'Elderly',
      state: aggressive ? 'Aggressive' : 'Confused',
      label: aggressive ? 'Aggressive Adult' : 'Confused Elderly',
      gender: Math.random() < 0.5 ? 'M' : 'F',
      isPlayer: false,
    };

    this.gs.insertCutterInFrontOfPlayer(cutter);
    this.world.syncQueue(this.gs.queue);

    this.gs.activeEvent = {
      type: 'CUTTER',
      npc: cutter,
      cutter,
      blocksCheckout: false,
      startedAt: this.gs.elapsedSec,
      options: [
        { key: 'ARGUE_WITH_CUTTER', label: '🗣️ Argue (50/50)', style: 'warn' },
        { key: 'LET_IT_GO',         label: '🙏 Let it go',     style: 'ghost' },
      ],
    };

    this.ui.banner(`⚠️ A "${cutter.label}" is cutting directly in front of you.`);
    this.ui.log(`A ${cutter.label.toLowerCase()} cut into the queue right in front of you.`, 'bad');
    this.ui.speech(cutter.id, aggressive ? "I'm in a rush!" : 'Was I next?');
    this.world.setEmotion(cutter.id, aggressive ? 'angry' : 'neutral');
    this.world.setEmotion('PLAYER', 'shocked');
    this.world.setCashierEmotion('surprised');
    setTimeout(() => this.world.setCashierEmotion('neutral'), 4000);
    this.ui.renderActions(this.gs.activeEvent.options, (key) => this.resolveCutter(key));
    this.world.triggerUrgentShake();
  }

  resolveCutter(action) {
    if (!this.gs.activeEvent) return;
    const prevState = this.gs.snapshotState();
    const cutter = this.gs.activeEvent.cutter;

    if (action === 'ARGUE_WITH_CUTTER') {
      const success = Math.random() < CONFIG.ARGUE_SUCCESS_P;
      const argDurationS = success
        ? gaussian(CONFIG.ARGUE_BASE_S, 1.5, 2.5)
        : gaussian(CONFIG.ARGUE_ESCALATE_S, 3.0, 5.0);
      const argDurationMs = argDurationS * 1000;

      this.world.setEmotion('PLAYER', 'angry');
      this.world.setEmotion(cutter.id, 'angry');
      this.world.gestureCharacter('PLAYER', 'shake', argDurationMs);
      this.world.gestureCharacter(cutter.id, 'shake', argDurationMs);

      // Face each other for the whole argument (override the queue rotation
      // so the cutter actually turns around to face the player, not stay
      // facing forward in line).
      this.world.faceTowards('PLAYER', cutter.id);
      this.world.faceTowards(cutter.id, 'PLAYER');

      // Pin both in place — queue ahead of them advances while they yell;
      // they fill the gap when the argument ends.
      const playerPos = this.world.getCharacterPos('PLAYER');
      const cutterPos = this.world.getCharacterPos(cutter.id);
      if (playerPos) this.world.playScript('PLAYER',  [{ target: playerPos.clone(),  durationS: argDurationS }]);
      if (cutterPos) this.world.playScript(cutter.id, [{ target: cutterPos.clone(), durationS: argDurationS }]);

      // Speech beats spread across the duration so it really FEELS like a
      // multi-second argument and not a one-line resolve.
      this.ui.speech('PLAYER', 'Hey — the line is here!', 1800);
      const t1 = Math.min(argDurationMs * 0.30, 1600);
      const t2 = Math.min(argDurationMs * 0.55, 3200);
      const t3 = Math.min(argDurationMs * 0.80, 5500);
      setTimeout(() => this.ui.speech(cutter.id, success ? 'I just need a few things…' : 'I was already here!'), t1);
      setTimeout(() => this.ui.speech('PLAYER', success ? 'No, you really need to wait.' : 'That\'s not how a queue works!'), t2);
      if (argDurationMs > 4500) {
        setTimeout(() => this.ui.speech(cutter.id, success ? 'Ugh, fine…' : 'Whatever, I\'m staying.'), t3);
      }

      this.ui.banner(`💬 Arguing... (~${argDurationS.toFixed(0)}s)`);
      this.ui.renderLockedAction(`💬 Arguing… (~${argDurationS.toFixed(0)}s)`);
      this.ui.log(
        `🗣️ You start arguing with the cutter. ${success ? 'They might back off…' : 'This is getting ugly…'}`,
        'warn'
      );

      setTimeout(() => {
        // Release the rotation overrides so they revert to queue rotation.
        this.world.clearRotationOverride('PLAYER');
        this.world.clearRotationOverride(cutter.id);

        if (success) {
          this.world.setEmotion(cutter.id, 'sad');
          this.world.setEmotion('PLAYER', 'neutral');
          this.ui.speech(cutter.id, '...fine.');
          this.world.setCustomExit(cutter.id, new THREE.Vector3(4.0, 0, 4.5), 1.6);
          this.gs.removeById(cutter.id);
          this.world.syncQueue(this.gs.queue);
          this.ui.log(`✅ The cutter backed off after ${argDurationS.toFixed(1)}s of arguing.`, 'good');
        } else {
          this.world.gestureCharacter(cutter.id, 'dismissive', 900);
          this.world.setEmotion(cutter.id, 'happy'); // smug
          this.ui.log(`💢 ${argDurationS.toFixed(1)}s of shouting and they stayed.`, 'bad');
        }
        this._finishEvent(action, prevState);
      }, argDurationMs);
      return;
    }

    // LET_IT_GO — cutter stays; player slumps in resignation.
    this.world.setEmotion('PLAYER', 'sad');
    this.world.setEmotion(cutter.id, 'happy'); // smug
    this.world.gestureCharacter('PLAYER', 'slump', 1400);
    this.ui.speech('PLAYER', '*sigh*');
    this.ui.log(
      `🙏 You said nothing. The cutter stays — you'll wait through their full cycle (~${CONFIG.CASHIER_MEAN_S}s extra).`,
      'warn'
    );
    this._finishEvent(action, prevState);
  }

  // =======================================================================
  // Event C — The "Israeli Queue" / friend cut-in.
  // =======================================================================
  triggerIsraeliQueue() {
    const playerIdx = this.gs.playerIndex();
    if (playerIdx <= 0) return;
    const inFront = this.gs.queue[playerIdx - 1];
    if (!inFront || inFront.isPlayer) return;
    this.gs.eventsCount++;

    const friend = {
      id: 'frnd_' + Math.random().toString(36).slice(2, 10),
      age: 'Adult',
      state: 'FriendJoiner',
      label: 'Friend',
      gender: Math.random() < 0.5 ? 'M' : 'F',
      isPlayer: false,
    };

    this.gs.insertFriendInFrontOfPlayer(friend);
    this.world.syncQueue(this.gs.queue);

    this.gs.activeEvent = {
      type: 'ISRAELI_QUEUE',
      npc: inFront,
      friend,
      blocksCheckout: false,
      startedAt: this.gs.elapsedSec,
      options: [
        { key: 'OBJECT_TO_GROUP',     label: '🙋 Object directly', style: 'warn' },
        { key: 'COMPLAIN_TO_CASHIER', label: '🗣️ Tell cashier',    style: 'warn' },
        { key: 'WAIT',                label: '😐 Wait silently',   style: 'ghost' },
      ],
    };

    this.ui.banner(`⚠️ "${inFront.label}" called a friend over: "I saved you a spot!"`);
    this.ui.log(`${inFront.label} called over a friend who jumped into the line in front of you.`, 'bad');
    this.ui.speech(inFront.id, 'I saved you a spot!');
    this.world.setEmotion(inFront.id, 'happy');
    this.world.setEmotion(friend.id, 'happy'); // smug
    this.world.setEmotion('PLAYER', 'shocked');
    this.world.setCashierEmotion('surprised');
    setTimeout(() => this.world.setCashierEmotion('neutral'), 4000);
    this.ui.renderActions(this.gs.activeEvent.options, (key) => this.resolveIsraeliQueue(key));
    this.world.triggerUrgentShake();
  }

  resolveIsraeliQueue(action) {
    if (!this.gs.activeEvent) return;
    const prevState = this.gs.snapshotState();
    const friend = this.gs.activeEvent.friend;
    const inFront = this.gs.activeEvent.npc;

    if (action === 'OBJECT_TO_GROUP') {
      this.gs.addCashierDelay(CONFIG.OBJECT_GROUP_S);
      const success = Math.random() < CONFIG.OBJECT_GROUP_SUCCESS_P;
      // Multi-second back-and-forth so the confrontation reads as an
      // actual argument, not a single line.
      const objectDurationMs = gaussian(5.0, 1.2, 3.5) * 1000;

      this.world.setEmotion('PLAYER', 'angry');
      this.world.setEmotion(friend.id, 'angry');
      this.world.gestureCharacter('PLAYER', 'point', objectDurationMs * 0.5);
      this.world.gestureCharacter(friend.id, 'shake', objectDurationMs * 0.5);

      // Face each other.
      this.world.faceTowards('PLAYER', friend.id);
      this.world.faceTowards(friend.id, 'PLAYER');

      // Pin them in place for the duration of the dispute.
      const playerPos = this.world.getCharacterPos('PLAYER');
      const friendPos = this.world.getCharacterPos(friend.id);
      const argS = objectDurationMs / 1000;
      if (playerPos) this.world.playScript('PLAYER',   [{ target: playerPos.clone(),  durationS: argS }]);
      if (friendPos) this.world.playScript(friend.id,  [{ target: friendPos.clone(), durationS: argS }]);

      // Speech beats
      this.ui.speech('PLAYER', 'You can\'t just cut in!', 1900);
      setTimeout(() => this.ui.speech(friend.id, 'My friend saved my spot!'), Math.min(1500, objectDurationMs * 0.32));
      setTimeout(() => this.ui.speech('PLAYER', 'That\'s not how this works.'), Math.min(3000, objectDurationMs * 0.60));

      this.ui.banner(`💬 Objecting to the friend… (~${argS.toFixed(0)}s)`);
      this.ui.renderLockedAction(`💬 Arguing… (~${argS.toFixed(0)}s)`);

      setTimeout(() => {
        this.world.clearRotationOverride('PLAYER');
        this.world.clearRotationOverride(friend.id);

        if (success) {
          this.world.setEmotion(friend.id, 'sad');
          this.world.setEmotion('PLAYER', 'neutral');
          this.world.gestureCharacter(friend.id, 'dismissive', 700);
          this.ui.speech(friend.id, 'Whatever, fine.');
          this.gs.sendToBack(friend);
          this.world.syncQueue(this.gs.queue);
          this.ui.log(`✅ You objected and the friend went to the back of the line.`, 'good');
        } else {
          this.world.gestureCharacter(friend.id, 'head-shake', 800);
          this.ui.speech(friend.id, 'I\'m not moving.');
          this.ui.log(`😒 You argued but they ignored you. (-${CONFIG.OBJECT_GROUP_S}s wasted)`, 'bad');
        }
        this._finishEvent(action, prevState);
      }, objectDurationMs);
      return;
    } else if (action === 'COMPLAIN_TO_CASHIER') {
      this.gs.addCashierDelay(CONFIG.COMPLAIN_CASHIER_PENALTY_S);

      this.world.setEmotion('PLAYER', 'angry');
      this.world.gestureCharacter('PLAYER', 'point', 700);
      this.ui.speech('PLAYER', 'Excuse me — they cut in!');

      // Multi-beat cashier intervention: cashier looks up, asks what's going
      // on, scolds the friend, friend protests, then leaves.
      setTimeout(() => {
        this.world.cashierGesture(1800);
        this.world.setCashierEmotion('surprised');
        this.ui.speech('CASHIER', 'What\'s the problem here?', 1800);
      }, 700);
      setTimeout(() => {
        this.world.setCashierEmotion('angry');
        this.ui.speech('CASHIER', 'Excuse me — back of the line, please.', 2200);
      }, 2400);
      setTimeout(() => {
        this.world.setEmotion(friend.id, 'sad');
        this.ui.speech(friend.id, 'But my friend was holding…', 2000);
      }, 4400);
      setTimeout(() => {
        this.ui.speech('CASHIER', 'No exceptions. Back of the line.', 2200);
      }, 5800);
      setTimeout(() => {
        this.world.gestureCharacter(friend.id, 'slump', 900);
        this.ui.speech(friend.id, 'OK OK, fine.', 1500);
        this.gs.sendToBack(friend);
        this.world.syncQueue(this.gs.queue);
      }, 7400);
      setTimeout(() => this.world.setCashierEmotion('neutral'), 9500);

      this.ui.log(
        `🧑‍💼 The cashier intervenes. The current scan is slower (-${CONFIG.COMPLAIN_CASHIER_PENALTY_S}s) but the friend is sent away.`,
        'warn'
      );
    } else {
      // WAIT — friend stays directly in front of player.
      this.world.setEmotion('PLAYER', 'sad');
      this.world.gestureCharacter('PLAYER', 'slump', 1100);
      this.ui.log('😐 You waited. The friend stays directly in front of you.', 'warn');
    }

    this._finishEvent(action, prevState);
  }

  // =======================================================================
  // Shared finalization
  // =======================================================================
  _finishEvent(action, prevState) {
    this.gs.decisionsCount++;
    this.gs.activeEvent = null;
    this.ui.clearBanner();
    this.ui.renderDefaultActions();
    this.onAction(action, prevState, this.gs.points, 0);
    setTimeout(() => this.world.setEmotion('PLAYER', 'neutral'), 5000);
  }
}
