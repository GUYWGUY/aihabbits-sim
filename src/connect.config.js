// ============================================================================
// CloudResearch Connect — per-study settings. EDIT THIS FILE per deployment.
//
// When you create a study in Connect ("Create a Study"), the last step gives you
// a Redirect URL. Paste it here for the matching experiment. On finishing, the
// participant is sent to that URL, which is what hands them their completion
// code and marks the task complete on Connect's side.
//
// Leave a URL empty to disable the redirect — the end screen then just tells the
// participant they are done (useful for piloting outside Connect).
// ============================================================================

export const CONNECT_CONFIG = {
  REDIRECT_URL: {
    // Study "with times" — the /realtime experiment (time pressure)
    'realtime': 'https://connect.cloudresearch.com/participant/project/570B52049B/complete',
    // Study "without times" — the /social experiment (no time pressure)
    'social-norms': 'https://connect.cloudresearch.com/participant/project/D8C0223B7E/complete',
  },

  // How long the end screen is shown before the participant is sent back to
  // Connect. They can also click the button immediately.
  REDIRECT_DELAY_MS: 8000,
};

export function redirectUrlFor(experimentId) {
  return CONNECT_CONFIG.REDIRECT_URL[experimentId] || '';
}
