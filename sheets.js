const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Two separate tabs in one Google Sheet
const ENG_SHEET  = 'Engineer Attendance';
const PAY_SHEET  = 'Worker Payments';

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

// ─── SETUP: ENSURE BOTH TABS + HEADERS EXIST ─────────────────────────────────
async function ensureSheets() {
  const auth        = await getAuthClient();
  const sheetsApi   = google.sheets({ version: 'v4', auth });

  // Check existing tab names
  const meta  = await sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);

  const requests = [];

  // Add missing tabs
  if (!existing.includes(ENG_SHEET)) {
    requests.push({ addSheet: { properties: { title: ENG_SHEET } } });
  }
  if (!existing.includes(PAY_SHEET)) {
    requests.push({ addSheet: { properties: { title: PAY_SHEET } } });
  }
  if (requests.length) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
    console.log('✅ Created missing sheet tabs');
  }

  // Write headers if cells are empty
  await maybeWriteHeader(sheetsApi, ENG_SHEET,
    ['Date', 'Time', 'Engineer ID', 'Engineer Name', 'Resume Type', 'Site', 'Location', 'Latitude', 'Longitude']
  );
  await maybeWriteHeader(sheetsApi, PAY_SHEET,
    ['Date', 'Time Logged', 'Site', 'Engineer', 'Worker ID', 'Worker Name', 'Role', 'Amount (₦)', 'Status']
  );
}

async function maybeWriteHeader(sheetsApi, tabName, headers) {
  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
  });
  if (result.data.values?.[0]?.[0] !== headers[0]) {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });
    console.log(`✅ Header written to "${tabName}"`);
  }
}

// ─── LOG ENGINEER CHECK-IN ────────────────────────────────────────────────────
// Appends one row to the Engineer Attendance tab
async function logEngineerCheckin({ date, time, engineer, site, resumeType, locationLabel, latitude, longitude }) {
  try {
    const auth     = await getAuthClient();
    const sheetsApi = google.sheets({ version: 'v4', auth });
    const siteName  = resumeType === 'OFFICE' ? 'Office' : site.name;

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${ENG_SHEET}!A:I`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          time,
          engineer.id,
          engineer.name,
          resumeType,
          siteName,
          locationLabel,
          latitude,
          longitude,
        ]],
      },
    });
    console.log(`📝 Engineer check-in: ${engineer.name} at ${locationLabel} (${resumeType})`);
    return true;
  } catch (err) {
    console.error('❌ Engineer check-in sheet error:', err.message);
    return false;
  }
}

// ─── LOG WORKER PAYMENTS ──────────────────────────────────────────────────────
// Appends one row per worker to the Worker Payments tab.
// entries = [{ worker: { id, name, role }, amount: number | 'ABSENT' }]
async function logWorkerPayments({ date, time, engineer, site, entries }) {
  try {
    const auth     = await getAuthClient();
    const sheetsApi = google.sheets({ version: 'v4', auth });

    const rows = entries.map(({ worker, amount }) => [
      date,
      time,
      site.name,
      engineer.name,
      worker.id,
      worker.name,
      worker.role,
      amount === 'ABSENT' ? '' : amount,
      amount === 'ABSENT' ? 'ABSENT' : 'PRESENT',
    ]);

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${PAY_SHEET}!A:I`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });

    console.log(`📝 Worker payments logged: ${entries.length} entries for ${site.name}`);
    return true;
  } catch (err) {
    console.error('❌ Worker payment sheet error:', err.message);
    return false;
  }
}

// ─── GET TODAY'S WORKER PAY SUMMARY ──────────────────────────────────────────
// Returns all rows for a given site and date from the Worker Payments tab.
// Used by the REPORT command.
async function getWorkerPaySummary(siteName, dateString) {
  try {
    const auth     = await getAuthClient();
    const sheetsApi = google.sheets({ version: 'v4', auth });

    const result = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${PAY_SHEET}!A:I`,
    });

    return (result.data.values || [])
      .slice(1)
      .filter(r => r[0] === dateString && r[2] === siteName);
  } catch (err) {
    console.error('❌ Summary fetch error:', err.message);
    return [];
  }
}

module.exports = { ensureSheets, logEngineerCheckin, logWorkerPayments, getWorkerPaySummary };
