// Amazon MTurk integration: URL param parsing, preview gating, dev-mode escape hatch,
// and ExternalQuestion form submission.

const params = new URLSearchParams(window.location.search);

export const mturk = {
  assignmentId: params.get('assignmentId') || '',
  workerId: params.get('workerId') || '',
  hitId: params.get('hitId') || '',
  // Sandbox passes its own submitTo; production uses www.mturk.com.
  turkSubmitTo: params.get('turkSubmitTo') || '',
  devMode: params.get('dev') === '1',
  isPreview: false,
};

// "Preview" = the worker hasn't accepted the HIT yet.
mturk.isPreview =
  mturk.assignmentId === 'ASSIGNMENT_ID_NOT_AVAILABLE' ||
  (!mturk.assignmentId && !mturk.workerId);

if (mturk.devMode) mturk.isPreview = false;

export function enableDevMode() {
  mturk.devMode = true;
  mturk.isPreview = false;
  // eslint-disable-next-line no-console
  console.log('[mturk] Dev mode enabled — submission is stubbed to console.');
}

/**
 * Submit the trajectory + final score to MTurk via the hidden form.
 * In dev mode or preview mode this is a no-op (returns false).
 */
export function submitToMTurk({ finalScore, trajectory, metadata }) {
  const form = document.getElementById('mturk-form');
  form.assignmentId.value = mturk.assignmentId;
  form.workerId.value = mturk.workerId;
  form.hitId.value = mturk.hitId;
  form.final_score.value = String(finalScore);
  form.rl_trajectory_log.value = JSON.stringify(trajectory);
  form.metadata.value = JSON.stringify(metadata);

  if (mturk.devMode) {
    // eslint-disable-next-line no-console
    console.log('[mturk DEV] Would POST to externalSubmit:', {
      assignmentId: mturk.assignmentId,
      workerId: mturk.workerId,
      hitId: mturk.hitId,
      final_score: finalScore,
      trajectory,
      metadata,
    });
    return false;
  }
  if (mturk.isPreview) return false;

  form.action = mturk.turkSubmitTo
    ? `${mturk.turkSubmitTo}/mturk/externalSubmit`
    : 'https://www.mturk.com/mturk/externalSubmit';
  form.submit();
  return true;
}
