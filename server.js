require('dotenv').config();
const express = require('express');
const { logEngineerCheckin, logWorkerPayments, getWorkerPaySummary, ensureSheets } = require('./sheets');
const registry = require('./registry.json');

const app = express();
app.use(express.json());

const { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, PORT = 3000 } = process.env;

// ─── SESSION STATE ────────────────────────────────────────────────────────────
// In-memory. Survives message-to-message (seconds apart) but not server restarts.
// The code handles session loss gracefully — engineers just send IN again.
const sessions = new Map();

function getSession(phone) {
  return sessions.get(phone) || { stage: 'IDLE', data: {} };
}

function setSession(phone, stage, data = {}) {
  sessions.set(phone, { stage, data });
}

function clearSession(phone) {
  sessions.delete(phone);
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────
ensureSheets()
  .then(() => console.log('✅ Google Sheets ready'))
  .catch(err => console.error('⚠️  Sheets setup error (bot will still run):', err.message));

// ─── WEBHOOK VERIFICATION ────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Webhook verification failed');
  res.sendStatus(403);
});

// ─── RECEIVE MESSAGES ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond to Meta immediately — otherwise it retries
  res.sendStatus(200);

  try {
    const value   = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    // Ignore delivery receipts and other non-message events
    if (!message) return;

    const phone    = message.from;
    const msgType  = message.type;
    const engineer = registry.engineers[phone];

    console.log(`📨 [${phone}] type=${msgType} text="${message.text?.body ?? ''}"`);

    // ── Unregistered number ───────────────────────────────────────────────
    if (!engineer) {
      await send(phone, '❌ Your number is not registered.\n\nContact your project manager to be added.');
      return;
    }

    const site    = registry.sites[engineer.siteId];
    const session = getSession(phone);
    const now     = new Date();
    const date    = formatDate(now);
    const time    = formatTime(now);

    console.log(`👷 ${engineer.name} | stage=${session.stage}`);

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 0 — REPORT command (works from any stage, any time)
    // ═════════════════════════════════════════════════════════════════════════
    if (msgType === 'text' && message.text.body.trim().toUpperCase() === 'REPORT') {
      await handleReport(phone, engineer, site, date);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 0b — Location received but session was lost (Render restart etc.)
    // Gently prompt the engineer to start over rather than silently ignoring.
    // ═════════════════════════════════════════════════════════════════════════
    if (msgType === 'location' && session.stage !== 'AWAITING_LOCATION') {
      await send(phone,
        `📍 Got your location, but I lost track of where we were in the flow.\n\n` +
        `Please send *IN* to start again — it only takes a moment!`
      );
      clearSession(phone);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 1a — Any text in IDLE → start the check-in flow
    // ═════════════════════════════════════════════════════════════════════════
    if (session.stage === 'IDLE') {
      if (msgType !== 'text') {
        await send(phone, `Hi ${engineer.name}! 👋\n\nSend *IN* to log today's attendance.\nSend *REPORT* to see today's summary.`);
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

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 1b — Waiting for SITE / OFFICE reply
    // ═════════════════════════════════════════════════════════════════════════
    if (session.stage === 'AWAITING_SITE_OR_OFFICE') {
      if (msgType !== 'text') {
        await send(phone, 'Please reply with *SITE* or *OFFICE*.');
        return;
      }
      const text = message.text.body.trim().toUpperCase();
      if (text !== 'SITE' && text !== 'OFFICE') {
        await send(phone, `Please reply with just *SITE* or *OFFICE* — that's all I need.`);
        return;
      }
      setSession(phone, 'AWAITING_LOCATION', {
        ...session.data,
        resumeType: text,
      });
      await send(phone,
        `📍 Please share your location now.\n\n` +
        `Tap the *📎* icon at the bottom of the chat → *Location* → *Send Current Location*`
      );
      return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 1c — Waiting for location pin
    // ═════════════════════════════════════════════════════════════════════════
    if (session.stage === 'AWAITING_LOCATION') {
      // Engineer sent text instead of a location pin
      if (msgType !== 'location') {
        await send(phone,
          `📍 I need your location pin, not a text message.\n\n` +
          `Tap the *📎* icon → *Location* → *Send Current Location*`
        );
        return;
      }

      const { latitude, longitude, name, address } = message.location;
      const locationLabel = name
        ? `${name}${address ? ', ' + address : ''}`
        : `${Number(latitude).toFixed(4)}° N, ${Number(longitude).toFixed(4)}° E`;

      const resumeType = session.data.resumeType || 'SITE';
      const logDate    = session.data.date || date;
      const logTime    = session.data.time || time;

      console.log(`📍 Location received: ${locationLabel} (${resumeType})`);

      // ── Move session forward FIRST ────────────────────────────────────────
      setSession(phone, 'AWAITING_WORKERS', { date: logDate });

      // ── Reply to engineer IMMEDIATELY (don't wait for Sheets) ─────────────
      const rosterLines = site.workers.map(w => `• ${firstName(w.name)}`).join('  ');
      await send(phone,
        `✅ *Check-in recorded!*\n\n` +
        `📍 ${locationLabel}\n` +
        `🏷️  ${resumeType === 'SITE' ? site.name : 'Office'}\n` +
        `🕐 ${logTime}  ·  ${logDate}\n\n` +
        `──────────────────\n` +
        `When workers start, send their names and pay — one per line:\n\n` +
        `*Emeka 5000*\n` +
        `*Yusuf absent*\n` +
        `*Taiwo 3000*\n\n` +
        `Your roster: ${rosterLines}`
      );

      // ── Write to Sheets in the background (doesn't block the reply) ───────
      logEngineerCheckin({
        date: logDate, time: logTime,
        engineer, site, resumeType, locationLabel, latitude, longitude,
      }).then(ok => {
        if (!ok) console.warn(`⚠️  Sheets write failed for ${engineer.name}'s check-in`);
      }).catch(err => {
        console.error(`❌ Background Sheets error (check-in):`, err.message);
      });

      return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 2a — Waiting for worker pay list
    // ═════════════════════════════════════════════════════════════════════════
    if (session.stage === 'AWAITING_WORKERS') {
      if (msgType !== 'text') {
        await send(phone, 'Please send the worker list as a text message — one name and amount per line.');
        return;
      }

      const lines  = message.text.body.trim().split('\n').filter(Boolean);
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
          `⚠️  I couldn't read that list.\n\n` +
          `Please send it like this — one name and amount per line:\n\n` +
          `*Emeka 5000*\n*Yusuf absent*\n*Taiwo 3000*`
        );
        return;
      }

      const totalPay   = parsed.filter(p => p.amount !== 'ABSENT').reduce((s, p) => s + p.amount, 0);
      const presentCnt = parsed.filter(p => p.amount !== 'ABSENT').length;

      let summary = `Got it! Here's what I'll log:\n\n`;
      for (const { worker, amount } of parsed) {
        summary += amount === 'ABSENT'
          ? `❌ ${worker.name} — Absent\n`
          : `✅ ${worker.name} — ₦${amount.toLocaleString()}\n`;
      }
      summary += `\n💰 *Total: ₦${totalPay.toLocaleString()}* to ${presentCnt} worker${presentCnt !== 1 ? 's' : ''}`;
      if (unrecognised.length) {
        summary += `\n\n⚠️  Not found in roster: *${unrecognised.join(', ')}*\nCheck spelling and try again.`;
      }
      summary += `\n\nReply *OK* to confirm.`;

      setSession(phone, 'AWAITING_CONFIRM', {
        ...session.data,
        logTime: time,
        parsed,
      });

      await send(phone, summary);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STEP 2b — Waiting for OK confirmation
    // ═════════════════════════════════════════════════════════════════════════
    if (session.stage === 'AWAITING_CONFIRM') {
      if (msgType !== 'text') {
        await send(phone, 'Reply *OK* to save, or send a corrected list.');
        return;
      }

      const text = message.text.body.trim().toUpperCase();

      if (text === 'OK') {
        const { parsed, date: logDate, logTime } = session.data;

        const total   = parsed.filter(p => p.amount !== 'ABSENT').reduce((s, p) => s + p.amount, 0);
        const present = parsed.filter(p => p.amount !== 'ABSENT').length;
        const absent  = parsed.filter(p => p.amount === 'ABSENT').length;

        // ── Clear session and reply IMMEDIATELY ───────────────────────────
        clearSession(phone);
        await send(phone,
          `✅ *All logged to sheet!*\n\n` +
          `📍 ${site.name}\n` +
          `👷 Present: ${present}  ·  Absent: ${absent}\n` +
          `💰 Total pay: ₦${total.toLocaleString()}\n\n` +
          `Have a productive day! 🏗️`
        );

        // ── Write to Sheets in the background ────────────────────────────
        logWorkerPayments({
          date: logDate, time: logTime || time,
          engineer, site, entries: parsed,
        }).then(ok => {
          if (!ok) console.warn(`⚠️  Sheets write failed for worker payments on ${logDate}`);
        }).catch(err => {
          console.error(`❌ Background Sheets error (payments):`, err.message);
        });

        return;
      }

      // ── Engineer sent a revised list instead of OK ────────────────────
      const lines  = message.text.body.trim().split('\n').filter(Boolean);
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
        summary += amount === 'ABSENT' ? `❌ ${worker.name} — Absent\n` : `✅ ${worker.name} — ₦${amount.toLocaleString()}\n`;
      }
      summary += `\n💰 *Total: ₦${totalPay.toLocaleString()}* to ${presentCnt} workers`;
      if (unrecognised.length) summary += `\n⚠️  Not found: *${unrecognised.join(', ')}*`;
      summary += `\n\nReply *OK* to confirm.`;

      setSession(phone, 'AWAITING_CONFIRM', { ...session.data, parsed });
      await send(phone, summary);
      return;
    }

    // ─── FALLTHROUGH ──────────────────────────────────────────────────────────
    clearSession(phone);
    await send(phone,
      `Hi ${engineer.name}! 👋\n\nSend *IN* to log today's attendance.\nSend *REPORT* to see today's summary.`
    );

  } catch (err) {
    // Catch-all so a crash in message handling never hangs Meta's webhook
    console.error('❌ Unhandled error in message handler:', err);
  }
});

// ─── REPORT ──────────────────────────────────────────────────────────────────
async function handleReport(phone, engineer, site, date) {
  const rows = await getWorkerPaySummary(site.name, date);

  if (!rows.length) {
    await send(phone, `📊 *${site.name}*\n📅 ${date}\n\nNo attendance logged yet today.`);
    return;
  }

  const present = rows.filter(r => r[8] !== 'ABSENT');
  const absent  = rows.filter(r => r[8] === 'ABSENT');
  const total   = present.reduce((s, r) => s + (parseInt(r[7]) || 0), 0);

  let reply = `📊 *${site.name}*\n📅 ${date}\n\n`;
  if (present.length) {
    reply += `✅ Present (${present.length}):\n`;
    for (const r of present) reply += `  ${r[5]} — ₦${parseInt(r[7]).toLocaleString()}\n`;
  }
  if (absent.length) {
    reply += `\n❌ Absent (${absent.length}):\n`;
    for (const r of absent) reply += `  ${r[5]}\n`;
  }
  reply += `\n💰 Total pay: ₦${total.toLocaleString()}`;
  await send(phone, reply);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function matchWorker(input, workers) {
  const norm = input.toLowerCase().trim();
  return workers.find(w => {
    const full  = w.name.toLowerCase();
    const first = full.split(' ')[0];
    return full === norm || first === norm || full.startsWith(norm) || full.includes(norm);
  }) || null;
}

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
    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ WhatsApp send failed (${res.status}):`, errText);
    }
  } catch (err) {
    console.error('❌ Network error sending message:', err.message);
  }
}

function formatDate(d) {
  return d.toLocaleDateString('en-NG', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatTime(d) {
  return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function firstName(fullName) {
  return fullName.split(' ')[0];
}

app.listen(PORT, () => console.log(`🚀 Attendance bot running on port ${PORT}`));
