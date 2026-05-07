// RL trajectory logger. Each entry is a strict (S, A, R, S') tuple plus the
// time stamp and any immediate per-action penalty for downstream IRL training.

export class TrajectoryLogger {
  constructor() {
    this.entries = [];
    this.pointsAtLastSnapshot = 0;
  }

  init(initialPoints) {
    this.entries = [];
    this.pointsAtLastSnapshot = initialPoints;
  }

  /**
   * @param {object} args
   * @param {number} args.t                      time elapsed (seconds)
   * @param {object} args.state                  S_t snapshot
   * @param {string} args.action                 A_t (e.g. "HELP", "IDLE_WAIT")
   * @param {number} args.points                 current point total (used to compute R)
   * @param {object} args.nextState              S_{t+1} snapshot
   * @param {number} [args.immediatePenalty=0]   any non-time-based penalty embedded in this action
   */
  record({ t, state, action, points, nextState, immediatePenalty = 0 }) {
    const reward = Math.round(points - this.pointsAtLastSnapshot);
    this.entries.push({
      t: +t.toFixed(2),
      state,
      action,
      reward,
      immediate_action_penalty: immediatePenalty,
      next_state: nextState,
    });
    this.pointsAtLastSnapshot = points;
  }

  export() {
    return this.entries;
  }
}
