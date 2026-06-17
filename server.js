require('dotenv').config();
const express = require('express');
const { logEngineerCheckin, logWorkerPayments, ensureSheets } = require('./sheets');
const registry = require('./registry.json');

const app = express();
app.use(express.json());

const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// ─── SESSION STATE ────────────────────────────────────────────────────────────
// Tracks each engineer through the guided conversation steps.
// Stored in memory — lightweight, no database needed for this scale.
//
// stages:
//   IDLE               → waiting for any message to start
//   AWAITING_SITE_OR_OFFICE → asked "site or office?", waiting for reply
//   AWAITING_LOCATION  → asked for location pin, waiting for GPS share
//   AWAITING_WORKERS   → check-in done, waiting for worker pay list
//   AWAITING_CONFIRM   → showed summary, waiting for "OK" to confirm
//
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { stage: 'IDLE', data: {} });
  }
  return sessions.get(phone);
}

function setSession(phone, stage, data = {}) {
  sessions.set(phone, { stage, data });
}

function clearSession(phone) {
  sessions.set(phone, { stage: 'IDLE', data: {} });
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
ensureSheets().catch(console.error);

// ─── WEBHOOK VERIFICATION ────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── RECEIVE MESSAGES ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const value   = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return;

  const phone    = message.from;
  const engineer = registry.engineers[phone];

  if (!engineer) {
    await send(phone,
      '❌ Your number is not registered.\n\nContact your project manager to be added to the system.'
    );
    return;
  }

  const site    = registry.sites[engineer.siteId];
  const session = getSession(phone);
  const now     = new Date();
  const date    = formatDate(now);
  const time    = formatTime(now);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1a — Engineer sends any text to start (IN, Hi, anything)
  // ═══════════════════════════════════════════════════════════════════════════
  if (session.stage === 'IDLE' && message.type === 'text') {
    const text = message.text.body.trim().toUpperCase();

    // REPORT command — available any time regardless of stage
    if (text === 'REPORT') {
      await handleReport(phone, engineer, site, date);
      return;
    }

    setSession(phone, 'AWAITING_SITE_OR_OFFICE', { date, time });
    await send(phone,
      `Good morning, *${engineer.name}!* 👋\n\n` +
      `Are you resuming at *site* or *office* today?\n\n` +
      `Reply: *SITE* or *OFFICE*`
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1b — Engineer replies SITE or OFFICE
  // ═══════════════════════════════════════════════════════════════════════════
  if (session.stage === 'AWAITING_SITE_OR_OFFICE') {
    if (message.type !== 'text') {
      await send(phone, 'Please reply with *SITE* or *OFFICE*.');
      return;
    }

    const text = message.text.body.trim().toUpperCase();
    if (text !== 'SITE' && text !== 'OFFICE') {
      await send(phone, 'Please reply with *SITE* or *OFFICE*. That\'s all I need!');
      return;
    }

    setSession(phone, 'AWAITING_LOCATION', {
      ...session.data,
      resumeType: text,
    });

    await send(phone,
      `📍 Please share your location.\n\n` +
      `Tap the *📎* attachment icon → *Location* → *Send Current Location*`
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1c — Engineer shares their GPS location
  // ═══════════════════════════════════════════════════════════════════════════
  if (session.stage === 'AWAITING_LOCATION') {
    if (message.type !== 'location') {
      await send(phone,
        '📍 I need your location pin — not a text message.\n\n' +
        'Tap the *📎* icon → *Location* → *Send Current Location*'
      );
      return;
    }

    const { latitude, longitude, name, address } = message.location;
    const locationLabel = name
      ? `${name}${address ? ', ' + address : ''}`
      : `${latitude.toFixed(4)}° N, ${longitude.toFixed(4)}° E`;

    // Log engineer check-in to the Engineer Attendance sheet
    await logEngineerCheckin({
      date: session.data.date,
      time: session.data.time,
      engineer,
      site,
      resumeType: session.data.resumeType,
      locationLabel,
      latitude,
      longitude,
    });

    setSession(phone, 'AWAITING_WORKERS', {
      date: session.data.date,
    });

    // Show roster as a reminder so engineer knows the names to type
    const rosterLines = site.workers.map(w => `• ${w.name.split(' ')[0]}`).join('  ');

    await send(phone,
      `✅ *Check-in recorded!*\n\n` +
      `📍 ${locationLabel}\n` +
      `🏷️ ${session.data.resumeType === 'SITE' ? site.name : 'Office'}\n` +
      `🕐 ${session.data.time}  ·  ${session.data.date}\n\n` +
      `─────────────────\n` +
      `When workers start, send their names and pay — one per line:\n\n` +
      `*Emeka 5000*\n` +
      `*Yusuf 5000*\n` +
      `*Taiwo absent*\n\n` +
      `Your roster: ${rosterLines}`
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2a — Engineer sends the worker pay list
  // ═══════════════════════════════════════════════════════════════════════════
  if (session.stage === 'AWAITING_WORKERS') {
    if (message.type !== 'text') {
      await send(phone, 'Please send the worker list as a text message — one name and amount per line.');
      return;
    }

    const text = message.text.body.trim().toUpperCase();
    if (text === 'REPORT') {
      await handleReport(phone, engineer, site, session.data.date);
      return;
    }

    const lines = message.text.body.trim().split('\n').filter(Boolean);
    const parsed = [];
    const unrecognised = [];

    for (const line of lines) {
      // Accepts: "Emeka 5000" | "Emeka - 5000" | "Emeka: 5000" | "Emeka absent"
      const match = line.trim().match(/^([a-zA-ZÀ-ÖØ-öø-ÿ\s]+?)\s*[:\-]?\s*([\d,]+|absent)$/i);
      if (!match) { unrecognised.push(line.trim()); continue; }

      const inputName = match[1].trim();
      const rawAmount = match[2].trim().toLowerCase();
      const worker    = matchWorker(inputName, site.workers);

      if (!worker) { unrecognised.push(inputName); continue; }

      const amount = rawAmount === 'absent' ? 'ABSENT' : parseInt(rawAmount.replace(/,/g, ''), 10);
      parsed.push({ worker, amount });
    }

    if (parsed.length === 0) {
      await send(phone,
        '⚠️ I couldn\'t read that list.\n\n' +
        'Please send it like this — one name and amount per line:\n\n' +
        '*Emeka 5000*\n*Yusuf absent*\n*Taiwo 3000*'
      );
      return;
    }

    // Build confirmation summary
    const totalPay   = parsed.filter(p => p.amount !== 'ABSENT').reduce((s, p) => s + p.amount, 0);
    const presentCnt = parsed.filter(p => p.amount !== 'ABSENT').length;

    let summary = `Got it! Here's what I'll log:\n\n`;
    for (const { worker, amount } of parsed) {
      if (amount === 'ABSENT') {
        summary += `❌ ${worker.name} — Absent\n`;
      } else {
        summary += `✅ ${worker.name} — ₦${amount.toLocaleString()}\n`;
      }
    }
    summary += `\n💰 *Total: ₦${totalPay.toLocaleString()}* to ${presentCnt} worker${presentCnt !== 1 ? 's' : ''}`;

    if (unrecognised.length) {
      summary += `\n\n⚠️ Not found in roster: *${unrecognised.join(', ')}*\nCheck spelling and try again.`;
    }

    summary += `\n\nReply *OK* to confirm or send a corrected list.`;

    setSession(phone, 'AWAITING_CONFIRM', {
      ...session.data,
      time: time,
      parsed,
    });

    await send(phone, summary);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2b — Engineer confirms the summary
  // ═══════════════════════════════════════════════════════════════════════════
  if (session.stage === 'AWAITING_CONFIRM') {
    if (message.type !== 'text') {
      await send(phone, 'Reply *OK* to save the list, or send a corrected list.');
      return;
    }

    const text = message.text.body.trim().toUpperCase();

    // Engineer sent OK — write to sheets
    if (text === 'OK') {
      const { parsed, date: logDate, time: logTime } = session.data;

      const ok = await logWorkerPayments({
        date: logDate,
        time: logTime,
        engineer,
        site,
        entries: parsed,
      });

      if (ok) {
        const total    = parsed.filter(p => p.amount !== 'ABSENT').reduce((s, p) => s + p.amount, 0);
        const present  = parsed.filter(p => p.amount !== 'ABSENT').length;
        const absent   = parsed.filter(p => p.amount === 'ABSENT').length;
        clearSession(phone);
        await send(phone,
          `✅ *All logged to sheet!*\n\n` +
          `📍 ${site.name}\n` +
          `👷 Present: ${present}  ·  Absent: ${absent}\n` +
          `💰 Total pay: ₦${total.toLocaleString()}\n\n` +
          `Have a productive day! 🏗️`
        );
      } else {
        await send(phone, '⚠️ Could not save to the sheet right now. Please try again.');
      }
      return;
    }

    // Engineer sent a new list instead — re-parse it
    const lines = message.text.body.trim().split('\n').filter(Boolean);
    const parsed = [];
    const unrecognised = [];

    for (const line of lines) {
      const match = line.trim().match(/^([a-zA-ZÀ-ÖØ-öø-ÿ\s]+?)\s*[:\-]?\s*([\d,]+|absent)$/i);
      if (!match) { unrecognised.push(line.trim()); continue; }
      const inputName = match[1].trim();
      const rawAmount = match[2].trim().toLowerCase();
      const worker    = matchWorker(inputName, site.workers);
      if (!worker) { unrecognised.push(inputName); continue; }
      const amount = rawAmount === 'absent' ? 'ABSENT' : parseInt(rawAmount.replace(/,/g, ''), 10);
      parsed.push({ worker, amount });
    }

    if (parsed.length === 0) {
      await send(phone, 'Reply *OK* to confirm the previous list, or send a corrected list (one name + amount per line).');
      return;
    }

    const totalPay   = parsed.filter(p => p.amount !== 'ABSENT').reduce((s, p) => s + p.amount, 0);
    const presentCnt = parsed.filter(p => p.amount !== 'ABSENT').length;

    let summary = `Updated list:\n\n`;
    for (const { worker, amount } of parsed) {
      summary += amount === 'ABSENT'
        ? `❌ ${worker.name} — Absent\n`
        : `✅ ${worker.name} — ₦${amount.toLocaleString()}\n`;
    }
    summary += `\n💰 *Total: ₦${totalPay.toLocaleString()}* to ${presentCnt} workers`;
    if (unrecognised.length) summary += `\n⚠️ Not found: *${unrecognised.join(', ')}*`;
    summary += `\n\nReply *OK* to confirm.`;

    setSession(phone, 'AWAITING_CONFIRM', {
      ...session.data,
      parsed,
    });
    await send(phone, summary);
    return;
  }

  // ─── FALLTHROUGH ──────────────────────────────────────────────────────────
  clearSession(phone);
  await send(phone,
    `Hi ${engineer.name}! 👋\n\n` +
    `Send *IN* to start your attendance for today.\n` +
    `Send *REPORT* to see today\'s summary.`
  );
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Fuzzy name match — accepts first name, full name, or partial match
function matchWorker(input, workers) {
  const norm = input.toLowerCase().trim();
  return workers.find(w => {
    const full  = w.name.toLowerCase();
    const first = full.split(' ')[0];
    return full === norm || first === norm || full.startsWith(norm) || full.includes(norm);
  }) || null;
}

// REPORT command — shows today's logged summary for this site
async function handleReport(phone, engineer, site, date) {
  const { getWorkerPaySummary } = require('./sheets');
  const rows = await getWorkerPaySummary(site.name, date);

  if (!rows.length) {
    await send(phone,
      `📊 *${site.name}*\n📅 ${date}\n\nNo attendance logged yet today.`
    );
    return;
  }

  const present = rows.filter(r => r[7] !== 'ABSENT');
  const absent  = rows.filter(r => r[7] === 'ABSENT');
  const total   = present.reduce((s, r) => s + parseInt(r[7] || 0, 10), 0);

  let reply = `📊 *${site.name}*\n📅 ${date}\n\n`;
  reply += `✅ Present (${present.length}):\n`;
  for (const r of present) reply += `  ${r[4]} — ₦${parseInt(r[7]).toLocaleString()}\n`;
  if (absent.length) {
    reply += `\n❌ Absent (${absent.length}):\n`;
    for (const r of absent) reply += `  ${r[4]}\n`;
  }
  reply += `\n💰 Total pay: ₦${total.toLocaleString()}`;
  await send(phone, reply);
}

// Send a WhatsApp message
async function send(to, bodyText) {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: bodyText },
      }),
    });
    if (!res.ok) console.error('❌ WhatsApp send failed:', await res.text());
  } catch (err) {
    console.error('❌ Network error:', err.message);
  }
}

function formatDate(d) {
  return d.toLocaleDateString('en-NG', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatTime(d) {
  return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
}

app.listen(PORT, () => console.log(`🚀 Attendance bot running on port ${PORT}`));
