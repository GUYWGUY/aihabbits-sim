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
  constructor({ gameState, world, ui, onAction, onEndGame }) {
    this.gs = gameState;
    this.world = world;
    this.ui = ui;
    this.onAction = onAction;
    this.onEndGame = onEndGame;

    this.nextCheckSec = CONFIG.EVENT_FIRST_AT_S;
    this.activeDroppedItems = null;
  }

  maybeTrigger() {
    if (this.gs.gameMode === 'SOCIAL_NORMS') return;
    if (this.gs.activeEvent) {
      if (!this.gs.activeEvent.resolving &&
          this.gs.elapsedSec - this.gs.activeEvent.startedAt >= 10) {
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

    this.triggerRandomEvent();
  }

  triggerRandomEvent() {
    if (this.gs.finished) return;

    let t;
    if (this.gs.gameMode === 'SOCIAL_NORMS' && this.gs.eventSequence) {
      t = this.gs.eventSequence[this.gs.eventsCount];
    } else {
      const choices = ['DROP', 'CUTTER', 'ISRAELI_QUEUE'];
      t = choices[Math.floor(Math.random() * choices.length)];
    }

    if (!t) t = 'DROP';

    if (t === 'DROP') {
      this.triggerDrop();
    } else if (t === 'CUTTER') {
      this.triggerCutter();
    } else {
      // For Israeli Queue, we need a character in front of the player.
      // If none, fallback to DROP.
      const playerIdx = this.gs.playerIndex();
      if (playerIdx > 0 && this.gs.queue[playerIdx - 1] && !this.gs.queue[playerIdx - 1].isPlayer) {
        this.triggerIsraeliQueue();
      } else {
        this.triggerDrop();
      }
    }
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
    let actorStr = 'customer';
    if (at.age === 'Elderly') {
      actorStr = '<strong>elderly person</strong>';
    } else if (at.age === 'Youth') {
      actorStr = '<strong>young customer</strong>';
    } else if (at.state === 'Pregnant') {
      actorStr = '<strong>pregnant woman</strong>';
    } else if (at.state === 'Disabled') {
      actorStr = '<strong>disabled customer</strong>';
    } else if (at.state === 'BusyParent') {
      actorStr = '<strong>parent with a child</strong>';
    } else {
      actorStr = '<strong>customer</strong>';
    }

    const actionStr = '<strong>dropped their groceries</strong>';
    const flavor = `A ${actorStr} ${where} ${actionStr}.`;

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
    this.world.setSpectatorFocus(at.id);
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

    // Prevent the 10s auto-timeout from firing a second time while we animate.
    this.gs.activeEvent.resolving = true;

    if (action === 'HELP') {
      delaySec = CONFIG.HELP_DELAY_S;
      logKind = 'good';
      msg = `✋ You helped pick everything up. (-${delaySec}s wait${isAtCashier ? '' : ', no cashier delay'})`;

      const dropperPos = this.world.getCharacterPos(customer.id);
      const playerStart = this.world.getCharacterPos('PLAYER');
      let helperPos;
      if (dropperPos && playerStart) {
        helperPos = new THREE.Vector3(dropperPos.x + 0.55, 0, dropperPos.z + 0.45);
      } else {
        helperPos = this.world.getDropSitePos();
      }

      // Bypass lane to the right of the queue (queue is at x≈0.4, chars ~0.28 wide).
      const BYPASS_X = 1.85;
      const SPEED = 1 / 0.45; // units per second (matches original formula)

      // Walk-to path: step right → walk forward in bypass lane → approach dropper.
      const wp1 = new THREE.Vector3(BYPASS_X, 0, (playerStart || helperPos).z);
      const wp2 = new THREE.Vector3(BYPASS_X, 0, helperPos.z);
      const walkToSteps = [
        { target: wp1,       durationS: (playerStart || helperPos).distanceTo(wp1) / SPEED },
        { target: wp2,       durationS: wp1.distanceTo(wp2) / SPEED },
        { target: helperPos, durationS: wp2.distanceTo(helperPos) / SPEED },
      ];

      this.world.setEmotion('PLAYER', 'neutral');
      this.world.playScript('PLAYER', walkToSteps, () => {
        // Arrived — start item recovery and kneel for the full duration.
        const totalRecoverMs = items.length * 1100 + 1300 + 200;
        this.world.recoverItemsToNpc(items, customer.id, 1100, 1300);
        this.world.gestureCharacter('PLAYER', 'kneel', totalRecoverMs);
        setTimeout(() => this.world.setEmotion(customer.id, 'happy'), totalRecoverMs * 0.55);

        // Compute queue position now (frozen during event, safe to read here).
        const idx = this.gs.playerIndex();
        const back = this.world.queuePosition(idx >= 0 ? idx : 1);

        // Return path: step right → walk back in bypass lane → re-enter queue.
        const bp1 = new THREE.Vector3(BYPASS_X, 0, helperPos.z);
        const bp2 = new THREE.Vector3(BYPASS_X, 0, back.z);
        this.world.playScript('PLAYER', [
          { target: helperPos, durationS: totalRecoverMs / 1000 }, // stay in place
          { target: bp1,  durationS: helperPos.distanceTo(bp1) / SPEED },
          { target: bp2,  durationS: bp1.distanceTo(bp2) / SPEED },
          { target: back, durationS: bp2.distanceTo(back) / SPEED },
        ], () => this._finishEvent(action, prevState));
      });

    } else if (action === 'COMPLAIN') {
      delaySec = CONFIG.COMPLAIN_DELAY_S;
      logKind = 'warn';
      msg = `📢 You complained loudly. (-${delaySec}s${isAtCashier ? '' : ', no cashier delay'})`;

      this.world.setEmotion('PLAYER', 'angry');
      this.world.setEmotion(customer.id, 'sad');
      this.world.gestureCharacter('PLAYER', 'shake', 1500);
      this.ui.speech('PLAYER', 'Oh come on!');
      // Dropper kneels slightly after the player's complaint reaction.
      const recoverMsComplain = items.length * 1300 + 1100 + 200;
      setTimeout(() => {
        this.world.gestureCharacter(customer.id, 'kneel', 5000);
        this.world.recoverItemsToNpc(items, customer.id, 1300, 1100);
      }, 800);
      // Finish only after the dropper has collected everything.
      setTimeout(() => this._finishEvent(action, prevState), 800 + recoverMsComplain);

    } else {
      // DO_NOTHING
      delaySec = CONFIG.DO_NOTHING_DELAY_S;
      logKind = 'info';
      msg = `😶 You waited silently while the customer recovered. (-${delaySec}s)`;

      this.world.setEmotion('PLAYER', 'neutral');
      this.world.setEmotion(customer.id, 'sad');
      const recoverMsDoNothing = items.length * 2100 + 1400 + 200;
      setTimeout(() => {
        this.world.gestureCharacter(customer.id, 'kneel', 9000);
        this.world.recoverItemsToNpc(items, customer.id, 2100, 1400);
      }, 1000);
      setTimeout(() => this._finishEvent(action, prevState), 1000 + recoverMsDoNothing);
    }

    // Cashier penalty only when the dropper is blocking the front of queue.
    if (isAtCashier) {
      this.gs.addCashierDelay(delaySec);
    }
    this.ui.log(msg, logKind);
    this.activeDroppedItems = null;
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

    this.ui.banner(`⚠️ A "<strong>${cutter.label}</strong>" is <strong>cutting directly in front of you</strong>.`);
    this.ui.log(`A <strong>${cutter.label.toLowerCase()}</strong> <strong>cut into the queue</strong> right in front of you.`, 'bad');
    this.ui.speech(cutter.id, aggressive ? "I'm in a rush!" : 'Was I next?');
    this.world.setEmotion(cutter.id, aggressive ? 'angry' : 'neutral');
    this.world.setEmotion('PLAYER', 'shocked');
    this.world.setCashierEmotion('surprised');
    this.world.setSpectatorFocus(cutter.id);
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
      this.world.gestureCharacter('PLAYER', 'argue', argDurationMs);
      this.world.gestureCharacter(cutter.id, 'argue', argDurationMs);

      this.world.faceTowards('PLAYER', cutter.id);
      this.world.faceTowards(cutter.id, 'PLAYER');

      const playerPos = this.world.getCharacterPos('PLAYER');
      const cutterPos = this.world.getCharacterPos(cutter.id);
      if (playerPos) this.world.playScript('PLAYER',  [{ target: playerPos.clone(),  durationS: argDurationS }]);
      if (cutterPos) this.world.playScript(cutter.id, [{ target: cutterPos.clone(), durationS: argDurationS }]);

      // Sustained anger icons above both heads for the whole argument.
      this.ui.angerIcon('PLAYER', argDurationMs);
      this.ui.angerIcon(cutter.id, argDurationMs);

      // Speech + curse bubbles interleaved so the argument has texture.
      this.ui.speech('PLAYER', 'Hey — the line is here!', 1800);
      setTimeout(() => this.ui.curse(cutter.id, 1600), 500);

      const t1  = Math.min(argDurationMs * 0.30, 1600);
      const t2  = Math.min(argDurationMs * 0.55, 3200);
      const t3  = Math.min(argDurationMs * 0.80, 5500);
      const tc1 = Math.min(argDurationMs * 0.42, 2400);
      const tc2 = Math.min(argDurationMs * 0.68, 4600);
      setTimeout(() => this.ui.speech(cutter.id, success ? 'I just need a few things…' : 'I was already here!'), t1);
      setTimeout(() => this.ui.curse('PLAYER', 1500), tc1);
      setTimeout(() => this.ui.speech('PLAYER', success ? 'No, you really need to wait.' : 'That\'s not how a queue works!'), t2);
      setTimeout(() => this.ui.curse(cutter.id, 1500), tc2);
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
        this.world.setSpectatorFocus(null);
        // Release the rotation overrides so they revert to queue rotation.
        this.world.clearRotationOverride('PLAYER');
        this.world.clearRotationOverride(cutter.id);

        if (success) {
          this.world.setEmotion(cutter.id, 'sad');
          this.world.setEmotion('PLAYER', 'neutral');
          this.ui.speech(cutter.id, '...fine.');
          this.gs.sendToBack(cutter);
          
          const currentPos = this.world.getCharacterPos(cutter.id);
          const backPos = this.world.queuePosition(this.gs.queue.length - 1);
          if (currentPos) {
            this.world.playScript(cutter.id, [
              { target: new THREE.Vector3(3.5, 0, currentPos.z), durationS: 0.8 },
              { target: new THREE.Vector3(3.5, 0, backPos.z), durationS: Math.max(1, (backPos.z - currentPos.z) * 0.3) },
              { target: backPos, durationS: 0.8 }
            ]);
          }
          this.world.syncQueue(this.gs.queue);
          
          // Social Contagion: npc behind player is happy
          const pIdx = this.gs.playerIndex();
          if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
            const behindId = this.gs.queue[pIdx + 1].id;
            this.world.setEmotion(behindId, 'happy');
            this.world.gestureCharacter(behindId, 'kneel', 600);
          }
          this.ui.log(`✅ The cutter backed off to the end of the line after ${argDurationS.toFixed(1)}s.`, 'good');
        } else {
          this.world.gestureCharacter(cutter.id, 'dismissive', 900);
          this.world.setEmotion(cutter.id, 'happy'); // smug
          
          // Social Contagion: npc behind player is frustrated
          const pIdx = this.gs.playerIndex();
          if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
            const behindId = this.gs.queue[pIdx + 1].id;
            this.world.setEmotion(behindId, 'sad');
            this.world.gestureCharacter(behindId, 'head-shake', 1200);
          }
          this.ui.log(`💢 ${argDurationS.toFixed(1)}s of shouting and they stayed.`, 'bad');
        }
        this._finishEvent(action, prevState);
      }, argDurationMs);
      return;
    }

    // LET_IT_GO — cutter stays; player slumps in resignation.
    this.world.setSpectatorFocus(null);
    this.world.setEmotion('PLAYER', 'sad');
    this.world.setEmotion(cutter.id, 'happy'); // smug
    this.world.gestureCharacter('PLAYER', 'slump', 1400);
    this.ui.speech('PLAYER', '*sigh*');
    
    // Social contagion
    const pIdx = this.gs.playerIndex();
    if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
      const behindId = this.gs.queue[pIdx + 1].id;
      this.world.setEmotion(behindId, 'angry');
      this.world.gestureCharacter(behindId, 'head-shake', 1500);
    }
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

    this.ui.banner(`⚠️ "<strong>${inFront.label}</strong>" called a <strong>friend to jump ahead</strong>: "I saved you a spot!"`);
    this.world.gestureCharacter(inFront.id, 'wave', 2500);
    this.ui.log(`<strong>${inFront.label}</strong> called over a friend who <strong>jumped into the line</strong> in front of you.`, 'bad');
    this.ui.speech(inFront.id, 'I saved you a spot!');
    this.world.setEmotion(inFront.id, 'happy');
    this.world.setEmotion(friend.id, 'happy'); // smug
    this.world.setEmotion('PLAYER', 'shocked');
    this.world.setCashierEmotion('surprised');
    this.world.setSpectatorFocus(friend.id);
    setTimeout(() => this.world.setCashierEmotion('neutral'), 4000);
    this.ui.renderActions(this.gs.activeEvent.options, (key) => this.resolveIsraeliQueue(key));
    this.world.triggerUrgentShake();
  }

  resolveIsraeliQueue(action) {
    if (!this.gs.activeEvent) return;
    const prevState = this.gs.snapshotState();
    const friend = this.gs.activeEvent.friend;

    if (action === 'OBJECT_TO_GROUP') {
      this.gs.addCashierDelay(CONFIG.OBJECT_GROUP_S);
      const success = Math.random() < CONFIG.OBJECT_GROUP_SUCCESS_P;
      // Multi-second back-and-forth so the confrontation reads as an
      // actual argument, not a single line.
      const objectDurationMs = gaussian(5.0, 1.2, 3.5) * 1000;

      this.world.setEmotion('PLAYER', 'angry');
      this.world.setEmotion(friend.id, 'angry');
      this.world.setEmotion(this.gs.activeEvent.npc.id, 'angry');
      this.world.gestureCharacter('PLAYER', 'argue', objectDurationMs * 0.5);
      this.world.gestureCharacter(friend.id, 'argue', objectDurationMs * 0.5);

      this.world.faceTowards('PLAYER', friend.id);
      this.world.faceTowards(friend.id, 'PLAYER');

      const playerPos = this.world.getCharacterPos('PLAYER');
      const friendPos = this.world.getCharacterPos(friend.id);
      const argS = objectDurationMs / 1000;
      if (playerPos) this.world.playScript('PLAYER',   [{ target: playerPos.clone(),  durationS: argS }]);
      if (friendPos) this.world.playScript(friend.id,  [{ target: friendPos.clone(), durationS: argS }]);

      this.ui.angerIcon('PLAYER', objectDurationMs * 0.7);
      this.ui.angerIcon(friend.id, objectDurationMs * 0.7);

      this.ui.speech('PLAYER', 'You can\'t just cut in!', 1900);
      setTimeout(() => this.ui.curse(friend.id, 1600), 600);
      setTimeout(() => this.ui.speech(friend.id, 'My friend saved my spot!'), Math.min(1500, objectDurationMs * 0.32));
      setTimeout(() => this.ui.curse('PLAYER', 1500), Math.min(2300, objectDurationMs * 0.48));
      setTimeout(() => this.ui.speech('PLAYER', 'That\'s not how this works.'), Math.min(3000, objectDurationMs * 0.60));

      this.ui.banner(`💬 Objecting to the friend… (~${argS.toFixed(0)}s)`);
      this.ui.renderLockedAction(`💬 Arguing… (~${argS.toFixed(0)}s)`);

      setTimeout(() => {
        this.world.setSpectatorFocus(null);
        this.world.clearRotationOverride('PLAYER');
        this.world.clearRotationOverride(friend.id);
        this.world.clearScript('PLAYER');
        this.world.clearScript(friend.id);

        if (success) {
          this.world.setEmotion(friend.id, 'sad');
          this.world.setEmotion('PLAYER', 'neutral');
          this.world.gestureCharacter(friend.id, 'dismissive', 700);
          this.ui.speech(friend.id, 'Whatever, fine.');
          this.gs.sendToBack(friend);
          
          const currentPos = this.world.getCharacterPos(friend.id);
          const backPos = this.world.queuePosition(this.gs.queue.length - 1);
          if (currentPos) {
            this.world.playScript(friend.id, [
              { target: new THREE.Vector3(3.5, 0, currentPos.z), durationS: 0.8 },
              { target: new THREE.Vector3(3.5, 0, backPos.z), durationS: Math.max(1, (backPos.z - currentPos.z) * 0.3) },
              { target: backPos, durationS: 0.8 }
            ]);
          }
          this.world.syncQueue(this.gs.queue);
          
          const pIdx = this.gs.playerIndex();
          if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
            const behindId = this.gs.queue[pIdx + 1].id;
            this.world.setEmotion(behindId, 'happy');
          }
          this.ui.log(`✅ You objected and the friend went to the back of the line.`, 'good');
        } else {
          this.world.gestureCharacter(friend.id, 'head-shake', 800);
          this.ui.speech(friend.id, 'I\'m not moving.');
          
          const pIdx = this.gs.playerIndex();
          if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
            const behindId = this.gs.queue[pIdx + 1].id;
            this.world.setEmotion(behindId, 'sad');
            this.world.gestureCharacter(behindId, 'slump', 1100);
          }
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
        this.world.setEmotion(this.gs.activeEvent.npc.id, 'sad');
        this.ui.speech(friend.id, 'But my friend was holding…', 2000);
      }, 4400);
      setTimeout(() => {
        this.ui.speech('CASHIER', 'No exceptions. Back of the line.', 2200);
      }, 5800);
      setTimeout(() => {
        this.world.gestureCharacter(friend.id, 'slump', 900);
        this.ui.speech(friend.id, 'OK OK, fine.', 1500);
        this.gs.sendToBack(friend);
        
        const currentPos = this.world.getCharacterPos(friend.id);
        const backPos = this.world.queuePosition(this.gs.queue.length - 1);
        if (currentPos) {
          this.world.playScript(friend.id, [
            { target: new THREE.Vector3(3.5, 0, currentPos.z), durationS: 0.8 },
            { target: new THREE.Vector3(3.5, 0, backPos.z), durationS: Math.max(1, (backPos.z - currentPos.z) * 0.3) },
            { target: backPos, durationS: 0.8 }
          ]);
        }
        this.world.syncQueue(this.gs.queue);
        this.world.setSpectatorFocus(null);
      }, 7400);
      setTimeout(() => this.world.setCashierEmotion('neutral'), 9500);

      this.ui.log(
        `🧑‍💼 The cashier intervenes. The current scan is slower (-${CONFIG.COMPLAIN_CASHIER_PENALTY_S}s) but the friend is sent away.`,
        'warn'
      );
    } else {
      // WAIT — friend stays directly in front of player.
      this.world.setSpectatorFocus(null);
      this.world.setEmotion('PLAYER', 'sad');
      this.world.gestureCharacter('PLAYER', 'slump', 1100);
      
      const pIdx = this.gs.playerIndex();
      if (pIdx >= 0 && pIdx + 1 < this.gs.queue.length) {
        const behindId = this.gs.queue[pIdx + 1].id;
        this.world.setEmotion(behindId, 'angry');
        this.world.gestureCharacter(behindId, 'head-shake', 1500);
      }
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
    this.world.setSpectatorFocus(null); // Release camera focus
    // Catch up anyone who was frozen during the event (player + behind).
    this.world.syncQueue(this.gs.queue);
    this.ui.clearBanner();
    this.ui.renderDefaultActions();
    this.onAction(action, prevState, this.gs.points, 0);
    setTimeout(() => this.world.setEmotion('PLAYER', 'neutral'), 5000);

    if (this.gs.gameMode === 'SOCIAL_NORMS') {
      const initialInFront = this.gs.initialInFront || 0;
      const eventIndex = this.gs.eventsCount;

      const targetInFront = (eventIndex >= 20)
        ? 0
        : Math.max(1, initialInFront - Math.floor((eventIndex * (initialInFront - 1)) / 19));

      let currentInFront = this.gs.playerIndex();
      let advancedCount = 0;
      while (currentInFront > targetInFront && this.gs.queue.length > 0 && !this.gs.queue[0].isPlayer) {
        this.gs.queue.shift();
        advancedCount++;
        currentInFront = this.gs.playerIndex();
      }

      if (advancedCount > 0) {
        this.gs.startNextCustomerAtCashier();
        this.world.syncQueue(this.gs.queue);
        this.ui.log(`🚶 The queue advanced. (${advancedCount} customer(s) checked out)`, 'good');
      }

      if (this.gs.eventsCount >= 20) {
        // Clear all characters in in-front of the player so they reach the cashier
        while (this.gs.queue.length > 0 && !this.gs.queue[0].isPlayer) {
          this.gs.queue.shift();
        }
        this.gs.startNextCustomerAtCashier();
        this.world.syncQueue(this.gs.queue);

        setTimeout(() => {
          this.ui.showConfetti();
          this.ui.banner("🎉 Congratulations! You reached the cashier.");
          this.ui.log("🎉 You reached the cashier! Checkout complete.", "good");
        }, 1000);

        setTimeout(() => {
          if (this.onEndGame) this.onEndGame('COMPLETED_SOCIAL_NORMS');
        }, 4500);
      } else {
        setTimeout(() => {
          this.triggerRandomEvent();
        }, 2500);
      }
    }
  }
}
