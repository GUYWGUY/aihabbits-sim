/**
 * Google Apps Script — tracking sheet for the Queueing Line Simulation studies.
 *
 * Setup (once):
 *   1. Create a Google Sheet. Note its URL.
 *   2. Extensions → Apps Script, paste this file, and set SECRET below to a long
 *      random string.
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as:        Me
 *        Who has access:    Anyone
 *      Copy the /exec URL.
 *   4. In Vercel → Settings → Environment Variables add:
 *        SHEETS_WEBHOOK_URL     = the /exec URL
 *        SHEETS_WEBHOOK_SECRET  = the same string as SECRET below
 *      Redeploy the project so the function picks them up.
 *
 * Paying bonuses: File → Download → CSV, keep the participant_id and
 * duration_total_sec columns, then Connect → Manage Participants → Upload CSV.
 */

const SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const SHEET_NAME = 'sessions';

const COLUMNS = [
  'received_at_iso',
  'participant_id',
  'assignment_id',
  'project_id',
  'session_id',
  'experiment_id',
  'completed',
  'end_reason',
  'final_score',
  'duration_total_sec',
  'duration_game_sec',
  'loaded_at_iso',
  'ended_at_iso',
  'decisions',
  'events',
  'trajectory_len',
  'blob_url',
];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (SECRET && data.secret !== SECRET) {
      return json({ ok: false, error: 'bad secret' });
    }

    const sheet = getSheet();
    sheet.appendRow(COLUMNS.map(function (c) { return data[c] !== undefined ? data[c] : ''; }));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
