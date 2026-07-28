import { CONFIG } from './config.js';
import { mturk, enableDevMode } from './mturk.js';
import { initLegendScreen } from './legend.js';

// ============================================================================
// HUD layer: builds the DOM overlay, manages screens (intro / end / preview),
// the action panel, the narrative log, the cashier progress bar, the event
// banner, and floating 3D-projected text and speech bubbles.
//
// Receives a reference to the World so it can project 3D positions to screen.
// ============================================================================

export class UI {
  constructor({ world, onStart, onSubmit, onDownload }) {
    this.world = world;
    this.onStart = onStart;
    this.onSubmit = onSubmit;
    this.onDownload = onDownload;

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
            <div class="sub">Real-pace 3D simulation · MTurk HIT</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="pill" id="workerPill"><span class="dot"></span><span id="workerText">Worker: —</span></span>
          <span class="pill warn" id="modePill"><span class="dot"></span><span id="modeText">Loading…</span></span>
        </div>
      </div>

      <div class="cashier-bar"><div id="cashierBar"></div></div>

      <div class="side">
        <div class="glass stat-card">
          <div class="stat-row">
            <div>
              <div class="stat-label">Current Points</div>
              <div class="score" id="scoreText">${CONFIG.INITIAL_POINTS}</div>
            </div>
            <div style="text-align:right">
              <div class="stat-label" id="elapsedLabel">Elapsed</div>
              <div style="font-size:22px; font-weight:700;" id="timeText">0s</div>
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

    this.scoreEl = document.getElementById('scoreText');
    this.timeEl = document.getElementById('timeText');
    this.posEl = document.getElementById('posText');
    this.qlenEl = document.getElementById('qlenText');
    this.cashPctEl = document.getElementById('cashPctText');
    this.decEl = document.getElementById('decText');
    this.cashierBarEl = document.getElementById('cashierBar');
    this.actionGridEl = document.getElementById('actionGrid');
    this.bannerEl = document.getElementById('eventBanner');
    this.bannerTextEl = document.getElementById('eventBannerText');
    this.logEl = document.getElementById('log');
    this.vignetteEl = document.getElementById('vignette');

    this.workerTextEl = document.getElementById('workerText');
    this.modePillEl = document.getElementById('modePill');
    this.modeTextEl = document.getElementById('modeText');

    this.workerTextEl.textContent =
      'Worker: ' + (mturk.workerId ? mturk.workerId.slice(0, 8) + '…' : '(none)');
  }

  // -----------------------------------------------------------------------
  // Intro screen with rules, stats, and start / dev-mode buttons.
  // -----------------------------------------------------------------------
  _buildIntroScreen() {
    this.selectedMode = 'REALTIME';
    const el = document.getElementById('introScreen');
    el.classList.add('active');
    el.innerHTML = `
      <div class="card glass two-col">
        <div>
          <h1>Stand in line. Make decisions.</h1>
          <p>You play one customer in a busy supermarket queue. Select your experiment mode below to begin.</p>

          <h2 style="margin-top:20px; margin-bottom:10px; font-size:16px; font-weight:700; color:#fff;">Select Experiment Mode:</h2>
          <div class="mode-cards">
            <div class="mode-card active" id="modeRealtimeCard">
              <div class="mode-card-title">⏱️ Real-Pace Simulation</div>
              <div class="mode-card-desc">Stand in line, make real-time decisions. The cashier processes customers. Time costs points (1 pt/sec). ~5 min.</div>
            </div>
            <div class="mode-card" id="modeSocialNormsCard">
              <div class="mode-card-title">🙋 Social Norms Mode</div>
              <div class="mode-card-desc">Focus strictly on social norms. 20 consecutive random events with no time pressure, no timers, and no point bleeding.</div>
            </div>
          </div>

          <ul class="rules" style="margin-top:20px;">
            <li><span class="ico">⏱️</span><div><strong>Goal:</strong> Reach the cashier or complete all scenarios with as many points as possible.</div></li>
            <li><span class="ico">🐢</span><div><strong>Social feedback:</strong> Other customers will do unexpected things — each interruption forces you to choose.</div></li>
            <li><span class="ico">🧓</span><div><strong>Mixed crowd:</strong> Youth, adults, elderly, pregnant, disabled — different reactions are expected.</div></li>
          </ul>
          <div class="legend" style="margin-top:15px;">
            <span>👵 Elderly</span><span>🤰 Pregnant</span><span>♿ Disabled</span><span>🧑 Adult</span><span>🧒 Youth</span>
          </div>
        </div>
        <aside class="aside">
          <h3>Session Parameters</h3>
          <div class="stat"><span>Initial points</span><strong>${CONFIG.INITIAL_POINTS}</strong></div>
          <div class="stat"><span>Time penalty</span><strong id="paramTimePenalty">−${CONFIG.TIME_PENALTY_PER_SEC} / sec</strong></div>
          <div class="stat"><span>Avg. checkout time</span><strong id="paramCheckoutTime">${CONFIG.CASHIER_MEAN_S}s (σ=${CONFIG.CASHIER_SD_S})</strong></div>
          <div class="stat"><span>Approx. duration</span><strong id="paramDuration">~5 min (max 10)</strong></div>
          <div class="stat"><span>Initial position</span><strong>~#${Math.round((CONFIG.INITIAL_QUEUE_LEN_RANGE[0] + CONFIG.INITIAL_QUEUE_LEN_RANGE[1]) / 2 + 1)} in line</strong></div>
          <div style="margin-top:auto; display:flex; gap:8px; flex-wrap:wrap;">
            <button id="startBtn" class="btn" disabled>▶ Start Simulation</button>
            <button id="legendBtn" class="btn" style="display:none; font-size:12px;">🔍 View 3D Legend</button>
          </div>
          <div id="previewNotice" class="notice" style="display:none">
            <div class="badge">PREVIEW MODE</div>
            <div>You must <strong>ACCEPT</strong> the HIT before you can play.</div>
            <div style="margin-top:10px;">
              <button id="devBtn" class="btn warn" style="font-size:12px; padding:8px 14px;">🛠️ Enable Dev Mode</button>
            </div>
            <div class="small">Dev mode bypasses the gate for local testing. MTurk submission stays disabled.</div>
          </div>
        </aside>
      </div>
    `;

    const realtimeCard = document.getElementById('modeRealtimeCard');
    const socialNormsCard = document.getElementById('modeSocialNormsCard');
    const paramTimePenalty = document.getElementById('paramTimePenalty');
    const paramCheckoutTime = document.getElementById('paramCheckoutTime');
    const paramDuration = document.getElementById('paramDuration');

    const updateModeSelection = (mode) => {
      this.selectedMode = mode;
      if (mode === 'REALTIME') {
        realtimeCard.classList.add('active');
        socialNormsCard.classList.remove('active');
        paramTimePenalty.textContent = `−${CONFIG.TIME_PENALTY_PER_SEC} / sec`;
        paramCheckoutTime.textContent = `${CONFIG.CASHIER_MEAN_S}s (σ=${CONFIG.CASHIER_SD_S})`;
        paramDuration.textContent = '~5 min (max 10)';
      } else {
        realtimeCard.classList.remove('active');
        socialNormsCard.classList.add('active');
        paramTimePenalty.textContent = 'None';
        paramCheckoutTime.textContent = 'N/A (Static cashier)';
        paramDuration.textContent = '20 events (No timer)';
      }
    };

    realtimeCard.addEventListener('click', () => updateModeSelection('REALTIME'));
    socialNormsCard.addEventListener('click', () => updateModeSelection('SOCIAL_NORMS'));

    document.getElementById('startBtn').addEventListener('click', () => {
      el.classList.remove('active');
      this.onStart(this.selectedMode);
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

  // -----------------------------------------------------------------------
  // End screen.
  // -----------------------------------------------------------------------
  _buildEndScreen() {
    const el = document.getElementById('endScreen');
    el.innerHTML = `
      <div class="card glass" style="text-align:center;">
        <h1 style="text-align:center;">Simulation Complete</h1>
        <p style="text-align:center;">Thank you for participating. Your decisions are being recorded for research.</p>
        <div class="big-score" id="finalScoreText">—</div>
        <p style="text-align:center;">Final points (will be converted to your MTurk bonus)</p>
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
        <div class="end-actions">
          <button id="submitBtn" class="btn success">📤 Submit to MTurk</button>
          <button id="downloadBtn" class="btn ghost">⬇️ Download trajectory (debug)</button>
        </div>
        <p class="stat-label" style="text-align:center; margin-top:14px;">
          Trajectory contains <span id="endTrajLen">0</span> state-action-reward tuples.
        </p>
      </div>
    `;
    document.getElementById('submitBtn').addEventListener('click', () => this.onSubmit());
    document.getElementById('downloadBtn').addEventListener('click', () => this.onDownload());
  }

  // -----------------------------------------------------------------------
  // Apply MTurk mode (Preview / Dev / Ready) to UI.
  // -----------------------------------------------------------------------
  _wireMode() {
    const startBtn = document.getElementById('startBtn');
    const previewNotice = document.getElementById('previewNotice');
    const legendBtn = document.getElementById('legendBtn');
    if (mturk.isPreview) {
      this.modePillEl.classList.add('warn');
      this.modeTextEl.textContent = 'Preview Mode';
      if (previewNotice) previewNotice.style.display = 'block';
      if (startBtn) startBtn.disabled = true;
      if (legendBtn) legendBtn.style.display = 'none';
    } else {
      this.modePillEl.classList.remove('warn');
      this.modeTextEl.textContent = mturk.devMode ? '🛠️ Dev Mode' : 'Ready';
      if (previewNotice) previewNotice.style.display = 'none';
      if (startBtn) startBtn.disabled = false;
      if (legendBtn) legendBtn.style.display = mturk.devMode ? 'inline-block' : 'none';
    }
  }

  showEndScreen({ finalScore, totalTimeSec, decisions, events, trajLen, gameMode }) {
    document.getElementById('finalScoreText').textContent = finalScore;
    if (gameMode === 'SOCIAL_NORMS') {
      document.getElementById('endTimeLabel').textContent = 'Total Scenarios';
      document.getElementById('endTime').textContent = events + ' / 20';
    } else {
      document.getElementById('endTimeLabel').textContent = 'Total Time';
      document.getElementById('endTime').textContent = totalTimeSec.toFixed(1) + 's';
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
    this.scoreEl.textContent = Math.round(score);
    if (gameMode === 'SOCIAL_NORMS') {
      document.getElementById('elapsedLabel').textContent = 'Scenarios';
      this.timeEl.textContent = `${eventsCount} / 20`;
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

  flashScore() {
    this.scoreEl.classList.remove('flash');
    void this.scoreEl.offsetWidth;
    this.scoreEl.classList.add('flash');
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
