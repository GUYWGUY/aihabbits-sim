// ============================================================================
// Background audio: a supermarket ambience bed plus light "muzak" music, both
// purely decorative. Browsers block autoplay-with-sound until a user gesture,
// so init() only creates and preloads the two <audio> elements — start()
// (called from a click handler, e.g. the intro screen's Start button) is what
// actually begins playback.
//
// This must never be load-bearing for the study: a 404'd file, a decode
// error, or a rejected play() should degrade silently (the other track keeps
// working, at worst both are silent) rather than break the session.
//
// We deliberately do NOT pause on visibilitychange. A participant switching
// tabs briefly (e.g. to re-read something) coming back to dead silence is a
// worse experience than a few seconds of audio playing unseen, so hidden
// tabs are just left alone.
// ============================================================================

const MUTE_KEY = 'sim.audio.muted';

// Neither bundled track requires attribution under the Pixabay Content
// License — see public/audio/LICENSES.md. Kept as a real join (rather than a
// hardcoded '') so a future track that does require credit only needs a
// change here, not in whatever UI displays it.
const ATTRIBUTION_LINES = [];

function clampVolume(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function readStoredMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false; // private mode / storage disabled — default unmuted
  }
}

function writeStoredMuted(value) {
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    /* nothing useful to do if storage is unavailable */
  }
}

function makeTrack(url, volume, label) {
  if (!url) return null;
  const el = new Audio();
  el.preload = 'auto';
  el.loop = true;
  el.volume = clampVolume(volume);
  // Attach the error handler before setting src so a synchronously-failing
  // load (e.g. a malformed URL) can't fire before we're listening.
  let warned = false;
  el.addEventListener('error', () => {
    if (warned) return; // log once per track — a stalled load can fire this repeatedly
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`[audio] failed to load ${label} track (${url})`);
  });
  el.src = url;
  baseVolumes.set(el, el.volume);
  return el;
}

let ambience = null;
let music = null;
let muted = readStoredMuted();
let initialized = false;
const fadeTimers = new WeakMap();  // <audio> element -> interval id
const baseVolumes = new WeakMap(); // <audio> element -> configured volume

function applyMuted() {
  if (ambience) ambience.muted = muted;
  if (music) music.muted = muted;
}

function clearFade(el) {
  const id = fadeTimers.get(el);
  if (id != null) {
    clearInterval(id);
    fadeTimers.delete(el);
  }
}

function fadeOutAndPause(el, fadeMs) {
  if (!el) return;
  clearFade(el);
  if (el.paused) return;

  const startVolume = el.volume;
  if (fadeMs <= 0 || startVolume <= 0) {
    el.pause();
    return;
  }

  const stepMs = 50;
  const steps = Math.max(1, Math.round(fadeMs / stepMs));
  let step = 0;
  const id = setInterval(() => {
    step++;
    el.volume = clampVolume(startVolume * (1 - step / steps));
    if (step >= steps) {
      clearFade(el);
      el.pause();
      el.volume = startVolume; // restore so the next start() isn't silent
    }
  }, stepMs);
  fadeTimers.set(el, id);
}

export const audio = {
  /** Create the two tracks and preload them. Does not start playback. */
  init({ ambienceUrl, musicUrl, ambienceVolume = 0.35, musicVolume = 0.12 } = {}) {
    // Re-init (e.g. hot reload) shouldn't leave orphaned elements playing.
    if (ambience) ambience.pause();
    if (music) music.pause();

    ambience = makeTrack(ambienceUrl, ambienceVolume, 'ambience');
    music = makeTrack(musicUrl, musicVolume, 'music');
    applyMuted();
    initialized = true;
  },

  /** Begin (or resume) playback of both tracks. Call from a user-gesture handler. */
  async start() {
    if (!initialized) return;
    applyMuted();
    await Promise.all(
      [ambience, music]
        .filter(Boolean)
        .map((el) => {
          // A start() during a stop()'s fade-out wins - and must undo the
          // partial fade, or playback resumes nearly silent for good.
          clearFade(el);
          const base = baseVolumes.get(el);
          if (base != null) el.volume = base;
          return el.play().catch((err) => {
            // Autoplay policy, a still-loading file, etc. — not fatal.
            // eslint-disable-next-line no-console
            console.warn('[audio] play() rejected:', err?.message || err);
          });
        })
    );
  },

  /** Fade both tracks out, then pause them. */
  stop({ fadeMs = 800 } = {}) {
    fadeOutAndPause(ambience, fadeMs);
    fadeOutAndPause(music, fadeMs);
  },

  setMuted(value) {
    muted = !!value;
    writeStoredMuted(muted);
    applyMuted();
  },

  toggleMuted() {
    audio.setMuted(!muted);
  },

  get muted() {
    return muted;
  },

  /** True once init() has run (tracks may still individually fail to load). */
  get ready() {
    return initialized;
  },

  attributionText: ATTRIBUTION_LINES.join(' '),
};
