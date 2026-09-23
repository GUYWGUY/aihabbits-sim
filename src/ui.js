import { CONFIG } from './config.js';
import { connect, enableDevMode } from './platform.js';
import { CONNECT_CONFIG } from './connect.config.js';
import { audio } from './audio.js';
import { initLegendScreen } from './legend.js';

// ============================================================================
// HUD layer: builds the DOM overlay, manages screens (intro / end / preview),
// the action panel, the narrative log, the cashier progress bar, the event
// banner, and floating 3D-projected text and speech bubbles.
//
// Receives a reference to the World so it can project 3D positions to screen.
// ============================================================================

export class UI {
  /**
   * @param {object} args
   * @param {object} args.experiment  the single experiment this page runs
   *                                  ({ mode, id, name, subtitle }) — see EXPERIMENTS in main.js
   */
  constructor({ world, experiment, onStart, onRetrySave, onDownload, onFinish }) {
    this.world = world;
    this.experiment = experiment;
    this.isSocialNorms = experiment.mode === 'SOCIAL_NORMS';
    this.onStart = onStart;
    this.onRetrySave = onRetrySave;
    this.onDownload = onDownload;
    this.onFinish = onFinish;
    this.redirectTimer = null;

    this.root = document.getElementById('hud');
    this._buildSkeleton();
    this._buildIntroScreen();
    this._buildEndScreen();
    this._wireMode();

    // 3D-anchored overlay items: { id, kind, vec3, el, ttlMs, currentMs }
    this.anchors = [];
  }

  // -----------------------------------------------------------------------
  // Build the persistent HUD (top bar, side panel, log, cashier bar, vignette).
  // -----------------------------------------------------------------------
  _buildSkeleton() {
    this.root.innerHTML = `
      <div class="urgent-vignette" id="vignette"></div>

      <div class="topbar glass">
        <div class="brand">
          <div class="logo">🛒</div>
          <div>
            <div class="title">Queueing Line Simulation</div>
            <div class="sub">${this.experiment.subtitle}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="pill" id="workerPill"><span class="dot"></span><span id="workerText">Participant: —</span></span>
          <span class="pill warn" id="modePill"><span class="dot"></span><span id="modeText">Loading…</span></span>
          <button class="pill pill-btn" id="muteBtn" type="button" title="Sound on / off">🔊 Sound</button>
        </div>
      </div>

      <div class="cashier-bar"><div id="cashierBar"></div></div>

      <div class="side">
        <div class="glass stat-card">
          <div class="stat-row">
            <div>
              <div class="stat-label" id="elapsedLabel">Elapsed</div>
              <div class="score" id="timeText">0s</div>
            </div>
          </div>
          <div style="height:10px"></div>
          <div class="kv">
            <div class="k">Position</div><div class="v" id="posText">—</div>
            <div class="k">Queue length</div><div class="v" id="qlenText">—</div>
            <div class="k">Cashier progress</div><div class="v" id="cashPctText">0%</div>
            <div class="k">Decisions made</div><div class="v" id="decText">0</div>
          </div>
        </div>

        <div class="glass event-banner" id="eventBanner">
          <span class="ico">⚠️</span>
          <div id="eventBannerText">An event is happening!</div>
          <span class="countdown" id="eventCountdown" style="display:none"></span>
        </div>

        <div class="glass actions">
          <h4>Action Panel</h4>
          <div class="action-grid" id="actionGrid"></div>
        </div>
      </div>

      <div class="glass log" id="log"></div>

      <div class="screen" id="introScreen"></div>
      <div class="screen" id="endScreen"></div>
      <div class="screen" id="legendScreen"></div>
    `;

    this.timeEl = document.getElementById('timeText');
    this.posEl = document.getElementById('posText');
    this.qlenEl = document.getElementById('qlenText');
    this.cashPctEl = document.getElementById('cashPctText');
    this.decEl = document.getElementById('decText');
    this.cashierBarEl = document.getElementById('cashierBar');
    this.actionGridEl = document.getElementById('actionGrid');
    this.bannerEl = document.getElementById('eventBanner');
    this.bannerTextEl = document.getElementById('eventBannerText');
    this.countdownEl = document.getElementById('eventCountdown');
    this.logEl = document.getElementById('log');
    this.vignetteEl = document.getElementById('vignette');

    this.muteBtn = document.getElementById('muteBtn');
    this.muteBtn.addEventListener('click', () => {
      audio.toggleMuted();
      this._syncMuteBtn();
    });
    this._syncMuteBtn();

    this.workerTextEl = document.getElementById('workerText');
    this.modePillEl = document.getElementById('modePill');
    this.modeTextEl = document.getElementById('modeText');

    this.workerTextEl.textContent =
      'Participant: ' + (connect.participantId ? connect.participantId.slice(0, 10) + '…' : '(none)');
  }

  _syncMuteBtn() {
    if (!this.muteBtn) return;
    this.muteBtn.textContent = audio.muted ? '🔇 Muted' : '🔊 Sound';
    this.muteBtn.classList.toggle('muted', audio.muted);
  }

  // -----------------------------------------------------------------------
  // Intro screen with rules, stats, and start / dev-mode buttons.
  // The page runs exactly one experiment, so there is no mode selector —
  // the copy and the session parameters are written for that experiment only.
  // -----------------------------------------------------------------------
  _buildIntroScreen() {
    const el = document.getElementById('introScreen');
    el.classList.add('active');
    el.innerHTML = `
      <div class="card glass two-col">
        <div>
          ${this.isSocialNorms ? this._introCopySocialNorms() : this._introCopyRealtime()}
          <div class="legend" style="margin-top:15px;">
            <span>👵 Elderly</span><span>🤰 Pregnant</span><span>♿ Disabled</span><span>🧑 Adult</span><span>🧒 Youth</span>
          </div>
        </div>
        <aside class="aside">
          <h3>Session Parameters</h3>
          ${this.isSocialNorms ? this._introParamsSocialNorms() : this._introParamsRealtime()}
          <div style="margin-top:auto; display:flex; gap:8px; flex-wrap:wrap;">
            <button id="startBtn" class="btn" disabled>${this.isSocialNorms ? '▶ Start Experiment' : '▶ Start Simulation'}</button>
            <button id="legendBtn" class="btn" style="display:none; font-size:12px;">🔍 View 3D Legend</button>
          </div>
          <div id="previewNotice" class="notice" style="display:none">
            <div class="badge">NO PARTICIPANT ID</div>
            <div>
              This link is missing its <strong>participantId</strong>, so your session could not be
              credited. Please return to <strong>CloudResearch Connect</strong> and open the study
              from the project link there.
            </div>
            <div style="margin-top:10px;">
              <button id="devBtn" class="btn warn" style="font-size:12px; padding:8px 14px;">🛠️ Enable Dev Mode</button>
            </div>
            <div class="small">Dev mode is for local testing only — results are logged to the console, not saved.</div>
          </div>
        </aside>
      </div>
    `;

    document.getElementById('startBtn').addEventListener('click', () => {
      el.classList.remove('active');
      this.onStart(this.experiment.mode);
    });
    document.getElementById('legendBtn').addEventListener('click', () => {
      el.classList.remove('active');
      document.getElementById('legendScreen').classList.add('active');
      initLegendScreen(this.world, () => {
        el.classList.add('active');
      });
    });
    const dev = document.getElementById('devBtn');
    if (dev) {
      dev.addEventListener('click', () => {
        enableDevMode();
        this._wireMode();
      });
    }
  }

  // ---- per-experiment intro copy ----------------------------------------
  _introCopyRealtime() {
    return `
      <h1>Stand in line. Beat the clock.</h1>
      <p>You play one customer in a busy supermarket queue, running at real supermarket pace.
         Every second you are still in line counts against your bonus, so every decision
         costs you time — and time is money.</p>
      <ul class="rules" style="margin-top:20px;">
        <li><span class="ico">⏱️</span><div><strong>Goal:</strong> Get through the checkout as quickly as you can.</div></li>
        <li><span class="ico">🐢</span><div><strong>Time counts:</strong> Every second in line is deducted from your bonus. Anything that delays the line costs you.</div></li>
        <li><span class="ico">⚠️</span><div><strong>Interruptions:</strong> Other customers will do unexpected things — each one forces you to choose, right now.</div></li>
        <li><span class="ico">🧓</span><div><strong>Mixed crowd:</strong> Youth, adults, elderly, pregnant, disabled — different reactions are expected.</div></li>
      </ul>
    `;
  }

  _introCopySocialNorms() {
    return `
      <h1>Stand in line. Make decisions.</h1>
      <p>You play one customer in a busy supermarket queue. This session is about social norms only:
         there is <strong>no timer and no time penalty</strong>. Take as long as you
         need on each scenario.</p>
      <ul class="rules" style="margin-top:20px;">
        <li><span class="ico">🙋</span><div><strong>Goal:</strong> Respond to each scenario the way you actually would in a real queue.</div></li>
        <li><span class="ico">🧘</span><div><strong>No rush:</strong> The clock never runs and nothing counts against you for taking your time.</div></li>
        <li><span class="ico">⚠️</span><div><strong>Interruptions:</strong> Drops, line-cutters and friends jumping in — each one forces you to choose.</div></li>
        <li><span class="ico">🧓</span><div><strong>Mixed crowd:</strong> Youth, adults, elderly, pregnant, disabled — different reactions are expected.</div></li>
      </ul>
    `;
  }

  _introParamsRealtime() {
    const avgStart = Math.round(
      (CONFIG.INITIAL_QUEUE_LEN_RANGE[0] + CONFIG.INITIAL_QUEUE_LEN_RANGE[1]) / 2 + 1
    );
    return `
      <div class="stat"><span>Experiment</span><strong>⏱️ Real-Pace</strong></div>
      <div class="stat"><span>Time pressure</span><strong>Yes — every second counts</strong></div>
      <div class="stat"><span>Avg. checkout time</span><strong>${CONFIG.CASHIER_MEAN_S}s (σ=${CONFIG.CASHIER_SD_S})</strong></div>
      <div class="stat"><span>Approx. duration</span><strong>~5 min</strong></div>
      <div class="stat"><span>Initial position</span><strong>~#${avgStart} in line</strong></div>
    `;
  }

  _introParamsSocialNorms() {
    return `
      <div class="stat"><span>Experiment</span><strong>🙋 Social Norms</strong></div>
      <div class="stat"><span>Time penalty</span><strong>None</strong></div>
      <div class="stat"><span>Cashier</span><strong>N/A (static)</strong></div>
      <div class="stat"><span>Approx. duration</span><strong>Self-paced</strong></div>
    `;
  }

  // -----------------------------------------------------------------------
  // End screen.
  // -----------------------------------------------------------------------
  _buildEndScreen() {
    const el = document.getElementById('endScreen');
    el.innerHTML = `
      <div class="card glass" style="text-align:center;">
        <h1 style="text-align:center;">Simulation Complete</h1>
        <p style="text-align:center;">Thank you for participating. Your decisions have been recorded for research.</p>
        <div class="end-grid">
          <div class="glass">
            <div class="stat-label" id="endTimeLabel">Total Time</div>
            <div class="num" id="endTime">—</div>
          </div>
          <div class="glass">
            <div class="stat-label">Decisions</div>
            <div class="num" id="endDecisions">—</div>
          </div>
          <div class="glass">
            <div class="stat-label">Events Faced</div>
            <div class="num" id="endEvents">—</div>
          </div>
        </div>

        <div class="save-status" id="saveStatus">
          <span class="ico" id="saveIcon">⏳</span>
          <span id="saveText">Saving your session…</span>
        </div>

        <div class="end-actions">
          <button id="finishBtn" class="btn success" disabled>✅ Finish &amp; return to Connect</button>
          <button id="retryBtn" class="btn warn" style="display:none;">🔄 Try saving again</button>
          <button id="downloadBtn" class="btn ghost">⬇️ Download my data (backup)</button>
        </div>
        <p class="stat-label" style="text-align:center; margin-top:14px;">
          Trajectory contains <span id="endTrajLen">0</span> state-action-reward tuples.
        </p>
      </div>
    `;
    this.saveStatusEl = document.getElementById('saveStatus');
    this.saveIconEl = document.getElementById('saveIcon');
    this.saveTextEl = document.getElementById('saveText');
    this.finishBtn = document.getElementById('finishBtn');
    this.retryBtn = document.getElementById('retryBtn');

    this.finishBtn.addEventListener('click', () => {
      this._cancelRedirectCountdown();
      if (this.onFinish && !this.onFinish()) {
        this.saveTextEl.textContent =
          'Saved. No Connect redirect is configured — you may close this tab.';
      }
    });
    this.retryBtn.addEventListener('click', () => this.onRetrySave && this.onRetrySave());
    document.getElementById('downloadBtn').addEventListener('click', () => this.onDownload());
  }

  // -----------------------------------------------------------------------
  // Save status on the end screen. The participant must not leave for Connect
  // before their data actually landed, so "Finish" only unlocks on success.
  // -----------------------------------------------------------------------
  setSaveStatus(state, detail = '') {
    if (!this.saveStatusEl) return;
    this.saveStatusEl.classList.remove('ok', 'bad');
    this.retryBtn.style.display = 'none';

    if (state === 'saving') {
      this.saveIconEl.textContent = '⏳';
      this.saveTextEl.textContent = 'Saving your session… please do not close this tab.';
      this.finishBtn.disabled = true;
      return;
    }
    if (state === 'saved') {
      this.saveStatusEl.classList.add('ok');
      this.saveIconEl.textContent = '✅';
      this.saveTextEl.textContent = 'Your session was saved successfully.';
      this.finishBtn.disabled = false;
      return;
    }
    if (state === 'dev') {
      this.saveStatusEl.classList.add('ok');
      this.saveIconEl.textContent = '🛠️';
      this.saveTextEl.textContent = 'Dev mode — nothing was saved; the payload was logged to the console.';
      this.finishBtn.disabled = false;
      return;
    }
    // failed
    this.saveStatusEl.classList.add('bad');
    this.saveIconEl.textContent = '⚠️';
    this.saveTextEl.textContent =
      `We could not save your session${detail ? ` (${detail})` : ''}. ` +
      `Please try again, or download the file and message the researcher through Connect.`;
    this.finishBtn.disabled = false;   // never trap a participant on this screen
    this.retryBtn.style.display = 'inline-block';
  }

  /** Auto-return to Connect a few seconds after a successful save. */
  startRedirectCountdown(onDone) {
    this._cancelRedirectCountdown();
    let left = Math.ceil(CONNECT_CONFIG.REDIRECT_DELAY_MS / 1000);
    const label = () => {
      this.finishBtn.textContent = `✅ Finish & return to Connect (${left}s)`;
    };
    label();
    this.redirectTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        this._cancelRedirectCountdown();
        onDone();
        return;
      }
      label();
    }, 1000);
  }

  _cancelRedirectCountdown() {
    if (this.redirectTimer) {
      clearInterval(this.redirectTimer);
      this.redirectTimer = null;
    }
    if (this.finishBtn) this.finishBtn.textContent = '✅ Finish & return to Connect';
  }

  // -----------------------------------------------------------------------
  // Gate the study on having a Connect participant id (or dev mode).
  // -----------------------------------------------------------------------
  _wireMode() {
    const startBtn = document.getElementById('startBtn');
    const previewNotice = document.getElementById('previewNotice');
    const legendBtn = document.getElementById('legendBtn');
    if (!connect.identified) {
      this.modePillEl.classList.add('warn');
      this.modeTextEl.textContent = 'Missing participant ID';
      if (previewNotice) previewNotice.style.display = 'block';
      if (startBtn) startBtn.disabled = true;
      if (legendBtn) legendBtn.style.display = 'none';
    } else {
      this.modePillEl.classList.remove('warn');
      this.modeTextEl.textContent = connect.devMode ? '🛠️ Dev Mode' : 'Ready';
      if (previewNotice) previewNotice.style.display = 'none';
      if (startBtn) startBtn.disabled = false;
      if (legendBtn) legendBtn.style.display = connect.devMode ? 'inline-block' : 'none';
    }
  }

  showEndScreen({ finalScore, totalTimeSec, durationTotalSec, decisions, events, trajLen, gameMode, hasRedirect }) {
    if (gameMode === 'SOCIAL_NORMS') {
      document.getElementById('endTimeLabel').textContent = 'Scenarios';
      document.getElementById('endTime').textContent = String(events);
    } else {
      document.getElementById('endTimeLabel').textContent = 'Total Time';
      document.getElementById('endTime').textContent = totalTimeSec.toFixed(1) + 's';
    }
    if (!hasRedirect) {
      this.finishBtn.textContent = '✅ Finish';
    }
    if (durationTotalSec != null) {
      this.finishBtn.title = `Session duration: ${durationTotalSec}s`;
    }
    document.getElementById('endDecisions').textContent = decisions;
    document.getElementById('endEvents').textContent = events;
    document.getElementById('endTrajLen').textContent = trajLen;
    document.getElementById('endScreen').classList.add('active');
  }

  // -----------------------------------------------------------------------
  // Stats panel updates.
  // -----------------------------------------------------------------------
  updateStats({ score, time, position, qlen, cashPct, decisions, gameMode, eventsCount }) {
    // `score` is deliberately not rendered: points stay in the trajectory
    // and in the saved session, but participants never see the number.
    if (gameMode === 'SOCIAL_NORMS') {
      document.getElementById('elapsedLabel').textContent = 'Scenarios';
      this.timeEl.textContent = `${eventsCount}`;
    } else {
      document.getElementById('elapsedLabel').textContent = 'Elapsed';
      this.timeEl.textContent = time.toFixed(1) + 's';
    }
    this.posEl.textContent =
      position === -1 ? '—' :
      position === 1 ? 'At Cashier' : '#' + position + ' in line';
    this.qlenEl.textContent = qlen;
    this.cashPctEl.textContent = Math.round(cashPct) + '%';
    this.decEl.textContent = decisions;
    this.cashierBarEl.style.width = cashPct.toFixed(1) + '%';
  }


  // -----------------------------------------------------------------------
  // Event banner + log + speech bubble + floating text.
  // -----------------------------------------------------------------------
  banner(text) {
    this.bannerTextEl.innerHTML = text;
    this.bannerEl.classList.add('show');
    this.vignetteEl.classList.add('active');
  }
  clearBanner() {
    this.bannerEl.classList.remove('show');
    this.vignetteEl.classList.remove('active');
    this.setDecisionCountdown(null, 0);
  }

  /**
   * Seconds left to decide on the active event (REALTIME only). `level` > 0
   * means the window is closing: the pill, the banner and the vignette turn
   * red and pulse. Pass null to hide.
   */
  setDecisionCountdown(remainingS, level = 0) {
    if (!this.countdownEl) return;
    if (remainingS === null || remainingS === undefined) {
      this.countdownEl.style.display = 'none';
      this.countdownEl.textContent = '';
      this.countdownEl.classList.remove('critical');
      this.bannerEl.classList.remove('critical');
      this.vignetteEl.classList.remove('critical');
      return;
    }
    const critical = level > 0;
    this.countdownEl.style.display = 'inline-flex';
    this.countdownEl.textContent = `⏱ ${Math.ceil(remainingS)}s`;
    this.countdownEl.classList.toggle('critical', critical);
    this.bannerEl.classList.toggle('critical', critical);
    this.vignetteEl.classList.toggle('critical', critical);
  }

  log(message, kind = 'info') {
    const p = document.createElement('p');
    p.className = kind;
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = `[${(this.world.clock.getElapsedTime()).toFixed(1)}s]`;
    p.appendChild(t);
    const span = document.createElement('span');
    span.innerHTML = ' ' + message;
    p.appendChild(span);
    this.logEl.appendChild(p);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Floating point text above an NPC's head, projected from 3D into screen-space. */
  floatPoints(amount, npcId) {
    const headPos = this.world.getCharacterHeadPos(npcId);
    if (!headPos) return;
    const el = document.createElement('div');
    el.className = 'float-text ' + (amount >= 0 ? 'gain' : 'loss');
    el.textContent = (amount >= 0 ? '+' : '') + amount;
    this.root.appendChild(el);
    this.anchors.push({
      kind: 'float',
      vec3: headPos,
      el,
      ttlMs: 1600,
      currentMs: 0,
    });
    setTimeout(() => el.remove(), 1600);
  }

  /** Anchored speech bubble above an NPC's head. Use 'CASHIER' to point at the cashier. */
  speech(npcId, text, ttlMs = 2400) {
    const headPos = npcId === 'CASHIER'
      ? this.world.getCashierHeadPos()
      : this.world.getCharacterHeadPos(npcId);
    if (!headPos) return;
    const el = document.createElement('div');
    el.className = 'speech';
    el.textContent = text;
    this.root.appendChild(el);
    this.anchors.push({
      kind: 'speech',
      vec3: headPos,
      el,
      ttlMs,
      currentMs: 0,
      npcId,
    });
    setTimeout(() => el.remove(), ttlMs);
  }

  /** Anger-styled (red) speech bubble with a random curse symbol string. */
  curse(npcId, ttlMs = 1800) {
    const CURSES = ['%@#!!', '#$@!', '@#$%!', '!@#$%', '*@#!!', '#%@$!', '!@#!!'];
    const text = CURSES[Math.floor(Math.random() * CURSES.length)];
    const headPos = npcId === 'CASHIER'
      ? this.world.getCashierHeadPos()
      : this.world.getCharacterHeadPos(npcId);
    if (!headPos) return;
    const el = document.createElement('div');
    el.className = 'speech curse';
    el.textContent = text;
    this.root.appendChild(el);
    this.anchors.push({ kind: 'speech', vec3: headPos, el, ttlMs, currentMs: 0, npcId });
    setTimeout(() => el.remove(), ttlMs);
  }

  /**
   * A little burst of emojis rising from above a character's head (gratitude,
   * relief...). Each one follows the head, drifts sideways and fades.
   */
  floatEmojis(npcId, emojis, ttlMs = 2400) {
    emojis.forEach((emoji, i) => {
      setTimeout(() => {
        const headPos = this.world.getCharacterHeadPos(npcId);
        if (!headPos) return;
        const el = document.createElement('div');
        el.className = 'float-emoji';
        el.textContent = emoji;
        el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 70)}px`);
        el.style.animationDuration = `${ttlMs}ms`;
        this.root.appendChild(el);
        this.anchors.push({
          kind: 'speech', vec3: headPos, el, ttlMs, currentMs: 0, npcId,
          yOffset3D: 0.45,
        });
        setTimeout(() => el.remove(), ttlMs);
      }, i * 260);
    });
  }

  /** Bobbing anger emoji above a character's head for the duration of an argument. */
  angerIcon(npcId, ttlMs = 3000) {
    const ICONS = ['💢', '⚡', '💢', '⚡', '😤'];
    const icon = ICONS[Math.floor(Math.random() * ICONS.length)];
    const headPos = npcId === 'CASHIER'
      ? this.world.getCashierHeadPos()
      : this.world.getCharacterHeadPos(npcId);
    if (!headPos) return;
    const el = document.createElement('div');
    el.className = 'anger-icon';
    el.textContent = icon;
    this.root.appendChild(el);
    this.anchors.push({
      kind: 'speech', vec3: headPos, el, ttlMs, currentMs: 0, npcId,
      yOffset3D: 0.55,
    });
    setTimeout(() => el.remove(), ttlMs);
  }

  /**
   * Per-frame: re-project anchored DOM elements onto screen-space.
   * Speech bubbles re-resolve their npc head every frame (queue may shift).
   */
  updateAnchors(dtMs) {
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const a = this.anchors[i];
      a.currentMs += dtMs;
      if (a.currentMs >= a.ttlMs || !a.el.isConnected) {
        this.anchors.splice(i, 1);
        continue;
      }
      let v;
      if (a.kind === 'speech' && a.npcId) {
        v = a.npcId === 'CASHIER'
          ? this.world.getCashierHeadPos()
          : this.world.getCharacterHeadPos(a.npcId);
        if (!v) continue;
      } else {
        v = a.vec3;
      }
      if (a.yOffset3D) v = v.clone().setY(v.y + a.yOffset3D);
      const screen = this.world.projectToScreen(v);
      a.el.style.left = screen.x + 'px';
      a.el.style.top = screen.y + 'px';
    }
  }

  // -----------------------------------------------------------------------
  // Action panel rendering.
  // -----------------------------------------------------------------------
  renderActions(options, onPick) {
    this.actionGridEl.innerHTML = '';
    options.forEach((opt) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (opt.style || '');
      b.textContent = opt.label;
      b.addEventListener('click', () => onPick(opt.key));
      this.actionGridEl.appendChild(b);
    });
  }

  renderDefaultActions() {
    this.actionGridEl.innerHTML = '';
    const b = document.createElement('button');
    b.className = 'btn ghost disabled';
    b.disabled = true;
    b.textContent = '⏳ WAIT';
    this.actionGridEl.appendChild(b);
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'No event right now. Stand by — buttons appear when something happens.';
    this.actionGridEl.appendChild(note);
  }

  /** Show a single disabled button while an action is in progress (e.g. arguing). */
  renderLockedAction(label) {
    this.actionGridEl.innerHTML = '';
    const b = document.createElement('button');
    b.className = 'btn ghost disabled';
    b.disabled = true;
    b.textContent = label;
    b.style.gridColumn = '1 / -1';
    this.actionGridEl.appendChild(b);
  }

  showConfetti() {
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.pointerEvents = 'none';
    container.style.overflow = 'hidden';
    container.style.zIndex = '9999';
    document.body.appendChild(container);

    const colors = ['#f2d53c', '#eb6383', '#fa9191', '#a29bfe', '#74b9ff', '#55efc4', '#ffeaa7'];

    for (let i = 0; i < 150; i++) {
      const p = document.createElement('div');
      p.style.position = 'absolute';
      p.style.width = Math.random() * 8 + 4 + 'px';
      p.style.height = Math.random() * 10 + 6 + 'px';
      p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      p.style.left = Math.random() * 100 + 'vw';
      p.style.top = -20 + 'px';
      p.style.borderRadius = '2px';
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      container.appendChild(p);

      const speed = Math.random() * 3 + 2;
      const angle = Math.random() * 2 - 1; // drift
      let top = -20;
      let left = parseFloat(p.style.left);
      let rot = Math.random() * 360;

      const anim = () => {
        top += speed;
        left += angle;
        rot += 5;
        p.style.top = top + 'px';
        p.style.left = left + 'px';
        p.style.transform = `rotate(${rot}deg)`;

        if (top < window.innerHeight) {
          requestAnimationFrame(anim);
        } else {
          p.remove();
        }
      };
      requestAnimationFrame(anim);
    }

    // Clean up container after 5 seconds
    setTimeout(() => {
      container.remove();
    }, 5000);
  }
}
