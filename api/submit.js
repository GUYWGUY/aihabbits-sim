// ============================================================================
// POST /api/submit — the only server-side piece of the study.
//
// CloudResearch Connect has no data channel back to the platform, so a finished
// session lands here and is written to two places:
//
//   1. Vercel Blob   — the full session JSON (trajectory included), one object
//                      per session. This is the research data.
//   2. Google Sheets — one summary row per session (participant id, completed,
//                      score, duration). This is the sheet you export as CSV for
//                      Connect → Manage Participants → Upload CSV to pay bonuses.
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   BLOB_READ_WRITE_TOKEN   set automatically when you connect a Blob store
//   SHEETS_WEBHOOK_URL      the /exec URL of the Apps Script in scripts/sheets-webhook.gs
//   SHEETS_WEBHOOK_SECRET   shared secret, must match the one in the Apps Script
//
// Either sink can be absent: the function still succeeds as long as at least one
// write lands, and reports per-sink status in the response.
// ============================================================================

import { put } from '@vercel/blob';

const MAX_BODY_BYTES = 4_000_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body = req.body;
  // sendBeacon posts a Blob; depending on the runtime it may arrive as a string.
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Body is not valid JSON' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing JSON body' });
  }

  const {
    participant_id,
    session_id,
    experiment_id,
    end_reason,
    completed,
    final_score,
    timing,
  } = body;

  if (!participant_id) {
    return res.status(400).json({ ok: false, error: 'participant_id is required' });
  }
  if (!session_id || !experiment_id) {
    return res.status(400).json({ ok: false, error: 'session_id and experiment_id are required' });
  }

  const serialized = JSON.stringify({ ...body, received_at_iso: new Date().toISOString() });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Payload too large' });
  }

  const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `sessions/${safe(experiment_id)}/${safe(participant_id)}__${safe(session_id)}__${safe(end_reason || 'UNKNOWN')}.json`;

  const result = { ok: false, blob: 'skipped', sheet: 'skipped', session_id };

  // ---- 1. full session JSON → Vercel Blob ---------------------------------
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      // The store is Private: blobs require a token to read, which is what we
      // want for participant data. Download them from the Vercel dashboard
      // (Storage → aihabbits-sim-blob → Manage Blobs) or with the SDK.
      const blob = await put(key, serialized, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      result.blob = 'ok';
      result.blob_url = blob.url;
    } catch (err) {
      result.blob = 'failed';
      result.blob_error = err?.message || String(err);
      console.error('[submit] blob write failed', err);
    }
  }

  // ---- 2. summary row → Google Sheets -------------------------------------
  if (process.env.SHEETS_WEBHOOK_URL) {
    try {
      const row = {
        secret: process.env.SHEETS_WEBHOOK_SECRET || '',
        received_at_iso: new Date().toISOString(),
        participant_id,
        assignment_id: body.assignment_id || '',
        project_id: body.project_id || '',
        session_id,
        experiment_id,
        completed: completed ? 'TRUE' : 'FALSE',
        end_reason: end_reason || '',
        final_score: final_score ?? '',
        duration_total_sec: timing?.duration_total_sec ?? '',
        duration_game_sec: timing?.duration_game_sec ?? '',
        loaded_at_iso: timing?.loaded_at_iso || '',
        ended_at_iso: timing?.ended_at_iso || '',
        decisions: body.metadata?.decisions_count ?? '',
        events: body.metadata?.events_count ?? '',
        trajectory_len: Array.isArray(body.trajectory) ? body.trajectory.length : '',
        blob_url: result.blob_url || '',
      };
      const sheetRes = await fetch(process.env.SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      result.sheet = sheetRes.ok ? 'ok' : `failed (HTTP ${sheetRes.status})`;
    } catch (err) {
      result.sheet = 'failed';
      result.sheet_error = err?.message || String(err);
      console.error('[submit] sheets write failed', err);
    }
  }

  // Succeed only if the session actually landed somewhere durable. Otherwise
  // the client retries, and failing that offers the participant a download.
  result.ok = result.blob === 'ok' || result.sheet === 'ok';
  if (!result.ok) {
    console.error('[submit] no sink accepted the session', { participant_id, session_id, result });
    return res.status(503).json({
      ...result,
      error: 'No storage sink is configured or reachable',
    });
  }

  return res.status(200).json(result);
}
