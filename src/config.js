// Single source of truth for all gameplay tunables.
// Designed-for total session length: ~5 minutes typical, up to 10 minutes.

export const CONFIG = {
  // ---- economy ----
  INITIAL_POINTS: 1000,
  TIME_PENALTY_PER_SEC: 1,

  // ---- engine timing ----
  TICK_MS: 100,                       // 10 Hz game tick
  MAX_DURATION_S: 600,                // 10-minute hard cap (safety net)

  // ---- cashier (real-pace, NOT sped up) ----
  // Real-world supermarket scan times: ~30s mean per customer (small-medium basket).
  CASHIER_MEAN_S: 30,
  CASHIER_SD_S: 8,
  CASHIER_MIN_S: 12,                  // clamp the lower tail

  // ---- queue composition ----
  INITIAL_QUEUE_LEN_RANGE: [7, 9],    // NPCs in front of player at start
  EXTRA_NPCS_BEHIND: 3,               // cosmetic queue length behind player

  // ---- event engine ----
  EVENT_FIRST_AT_S: 20,               // earliest possible event
  EVENT_CHECK_S: 18,                  // minimum spacing between checks
  EVENT_CHECK_JITTER_S: 4,            // randomness on top (average 20s)
  EVENT_PROB: 1.0,                    // P(trigger | check) - always trigger when check time arrives
  MAX_EVENTS: 12,                     // safety cap

  // ---- decision window (REALTIME only) ----
  // Once an event fires the participant has this long to choose; then the
  // passive option is taken for them. The warning kicks in near the end.
  DECISION_WINDOW_S: 10,
  DECISION_WARN_S: 4,

  // ---- per-event time costs (seconds added to the cashier-front timer) ----
  // Calibrated so the visual + the cashier penalty together feel like the real
  // amount of time the situation would consume in a supermarket queue.
  HELP_DELAY_S: 7,                    // walk over, kneel, pick 5 items, hand back, walk back
  COMPLAIN_DELAY_S: 9,                // customer recovers items themselves while you complain
  DO_NOTHING_DELAY_S: 14,             // customer recovers very slowly, no help
  ARGUE_BASE_S: 4,                    // brief but heated argument, cutter leaves
  ARGUE_ESCALATE_S: 10,               // dragged-out shouting match, cutter stays
  OBJECT_GROUP_S: 6,                  // verbal back-and-forth with the friend
  COMPLAIN_CASHIER_PENALTY_S: 8,      // cashier intervenes, scan slows visibly

  // ---- mid-game arrival pacing ----
  // How long a cutter or friend-joiner takes to walk into position from
  // outside the queue. Gives events tangible visual weight before any
  // decision is made.
  EVENT_NPC_WALK_IN_S: 2.8,

  // ---- cutter / friend probabilities ----
  ARGUE_SUCCESS_P: 0.5,
  OBJECT_GROUP_SUCCESS_P: 0.3,

  // ---- visuals ----
  CAMERA_SHAKE_AMP: 0.05,             // urgent-event shake
};
