// api/availability.js
// Vercel Serverless Function — reads the shoot calendar (private iCal feed) and
// reports remaining shoot-day capacity per month for the qualifier quiz.
//
// SETUP: In Google Calendar, open the "Jasmine Robertson" calendar →
// Settings → Integrate calendar → "Secret address in iCal format" (ends in
// /basic.ics). Add it in Vercel → Settings → Environment Variables as
// CALENDAR_ICAL_URL. Until that is set, this returns ok:false and the quiz
// falls back to its built-in numbers, so it is safe to deploy beforehand.
//
// LOGIC (per the studio's rules):
//   - Capacity is 6 SHOOT DAYS per calendar month.
//   - A "shoot" is any event whose title ends in "shoot date" (case-insensitive).
//     Multiple shoots on one day count as ONE shoot day.
//   - Vacation days (all-day events whose title contains a vacation keyword)
//     also consume a day, so a booked-out vacation lowers that month's count.
//   - Holidays are hardcoded and returned for reference. By default they do NOT
//     reduce the count (a scattered holiday shouldn't drop shoot capacity);
//     flip HOLIDAYS_REDUCE_CAPACITY to true if you want them to.
//   - remaining = max(0, 6 − distinct used days in the month). full = remaining 0.

const CAPACITY_PER_MONTH = 6;
const SHOOT_SUFFIX = 'shoot date';
const VACATION_KEYWORDS = ['vacation', 'ooo', 'out of office', 'blackout', 'closed', 'time off'];
const HOLIDAYS_REDUCE_CAPACITY = false;
const MONTHS_AHEAD = 8; // window computed: current month through +8

// Hardcoded blackout holidays (America/Detroit). Edit freely.
const HOLIDAYS = [
  '2026-01-01', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07',
  '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2026-12-31',
  '2027-01-01', '2027-05-31', '2027-07-04', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-11-26', '2027-12-24', '2027-12-25', '2027-12-31',
];

// --- iCal parsing -----------------------------------------------------------

// Unfold RFC5545 folded lines (continuations begin with a space or tab).
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

// Parse a "NAME;PARAM=x:VALUE" property line into { name, params, value }.
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > -1) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function unescapeText(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function pad(n) { return String(n).padStart(2, '0'); }

// Return YYYY-MM-DD for a DTSTART/DTEND property.
//  - VALUE=DATE (all-day): use the date digits directly.
//  - TZID present: the wall-clock date is already the intended local date.
//  - UTC ("...Z"): convert to America/Detroit via Intl for the correct local date.
//  - Floating: use the date digits.
function propDate(prop) {
  if (!prop) return null;
  const v = prop.value.trim();
  const digits = v.replace(/[^0-9TZ]/g, '');
  const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
  if (!y || !mo || !d) return null;
  const isAllDay = (prop.params.VALUE || '').toUpperCase() === 'DATE' || !v.includes('T');
  if (isAllDay || prop.params.TZID) return `${y}-${mo}-${d}`;
  if (/Z$/.test(v)) {
    const hh = digits.slice(9, 11) || '00', mi = digits.slice(11, 13) || '00';
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi));
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(dt);
      const g = t => parts.find(p => p.type === t).value;
      return `${g('year')}-${g('month')}-${g('day')}`;
    } catch (e) { return `${y}-${mo}-${d}`; }
  }
  return `${y}-${mo}-${d}`;
}

// Expand an all-day event that spans a range (DTEND is exclusive) into its days.
function expandRange(startISO, endISO) {
  const days = [startISO];
  if (!endISO || endISO === startISO) return days;
  const cur = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  cur.setUTCDate(cur.getUTCDate() + 1);
  let guard = 0;
  while (cur < end && guard++ < 400) {
    days.push(`${cur.getUTCFullYear()}-${pad(cur.getUTCMonth() + 1)}-${pad(cur.getUTCDate())}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function parseEvents(icsText) {
  const lines = unfold(icsText).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = { summary: '', dtstart: null, dtend: null, allDay: false }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'SUMMARY') cur.summary = unescapeText(p.value);
    else if (p.name === 'DTSTART') {
      cur.dtstart = p;
      cur.startISO = propDate(p);
      cur.allDay = (p.params.VALUE || '').toUpperCase() === 'DATE' || !p.value.includes('T');
    } else if (p.name === 'DTEND') {
      cur.dtend = p;
      cur.endISO = propDate(p);
    }
  }
  return events;
}

// --- classification & counting ---------------------------------------------

function classify(events) {
  const shootDays = new Set();
  const vacationDays = new Set();
  for (const ev of events) {
    if (!ev.startISO) continue;
    const title = (ev.summary || '').toLowerCase().trim();
    if (!title) continue;
    if (title.endsWith(SHOOT_SUFFIX)) {
      shootDays.add(ev.startISO);
    } else if (VACATION_KEYWORDS.some(k => title.includes(k))) {
      const days = ev.allDay ? expandRange(ev.startISO, ev.endISO) : [ev.startISO];
      days.forEach(d => vacationDays.add(d));
    }
  }
  return { shootDays, vacationDays };
}

function monthKeysAhead(from, count) {
  const keys = [];
  let y = from.getFullYear(), m = from.getMonth();
  for (let i = 0; i < count; i++) {
    keys.push(`${y}-${pad(m + 1)}`);
    m++; if (m > 11) { m = 0; y++; }
  }
  return keys;
}

function computeMonths(shootDays, vacationDays, now) {
  const holidays = new Set(HOLIDAYS);
  const keys = monthKeysAhead(now, MONTHS_AHEAD);
  const out = {};
  for (const key of keys) {
    const inMonth = d => d.startsWith(key + '-');
    const used = new Set();
    [...shootDays].filter(inMonth).forEach(d => used.add(d));
    [...vacationDays].filter(inMonth).forEach(d => used.add(d));
    if (HOLIDAYS_REDUCE_CAPACITY) [...holidays].filter(inMonth).forEach(d => used.add(d));
    const bookedCount = [...shootDays].filter(inMonth).length;
    const remaining = Math.max(0, CAPACITY_PER_MONTH - used.size);
    out[key] = {
      booked: bookedCount,
      blackout: [...vacationDays].filter(inMonth).length,
      remaining,
      full: remaining <= 0,
    };
  }
  return out;
}

// --- handler ----------------------------------------------------------------

export default async function handler(req, res) {
  // Allow any twowildsoulsphotography.com subdomain (apex, www, contact, …) and
  // Vercel previews — the marketing-site popup reads this feed cross-origin.
  const origin = req.headers.origin || '';
  if (/^https:\/\/([a-z0-9-]+\.)*twowildsoulsphotography\.com$/.test(origin) ||
      origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = process.env.CALENDAR_ICAL_URL;
  if (!url) {
    return res.status(200).json({ ok: false, reason: 'no_calendar_configured', capacity: CAPACITY_PER_MONTH });
  }

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'tws-availability/1.0' } });
    if (!r.ok) {
      return res.status(200).json({ ok: false, reason: 'fetch_failed', status: r.status, capacity: CAPACITY_PER_MONTH });
    }
    const text = await r.text();
    const events = parseEvents(text);
    const { shootDays, vacationDays } = classify(events);
    const months = computeMonths(shootDays, vacationDays, new Date());

    // Cache at the edge ~30 min; iCal feeds update slowly anyway.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: true,
      capacity: CAPACITY_PER_MONTH,
      months,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[availability] error:', err);
    return res.status(200).json({ ok: false, reason: 'error', capacity: CAPACITY_PER_MONTH });
  }
}

// Exported for local unit testing.
export const _internal = { unfold, parseLine, propDate, expandRange, parseEvents, classify, computeMonths };
