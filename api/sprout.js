// api/sprout.js
// Vercel Serverless Function — proxies lead submission to Sprout Studio API.
// Set SPROUT_API_KEY in Vercel → Settings → Environment Variables.
//
// IMPORTANT: Sprout's lead/new endpoint expects application/x-www-form-urlencoded
// (form-encoded), NOT JSON. Their PHP example uses http_build_query which sends
// form data. Sending JSON causes a 500 from Sprout.

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://contact.twowildsoulsphotography.com',
    'https://twowildsoulsphotography.com',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  if (allowed.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.SPROUT_API_KEY;
  if (!apiKey) {
    console.error('[sprout-proxy] SPROUT_API_KEY env var not set');
    return res.status(500).json({ error: 'Server configuration error', detail: 'SPROUT_API_KEY missing' });
  }

  const body    = req.body || {};
  const first   = (body.first   || '').toString().trim();
  const last    = (body.last    || '').toString().trim();
  const email   = (body.email   || '').toString().trim();
  const phone   = (body.phone   || '').toString().trim();
  const session = (body.session || '').toString().trim();
  const notes   = (body.notes   || '').toString().trim();

  if (!first || !email) {
    return res.status(400).json({ error: 'Missing required fields', detail: 'first and email required' });
  }

  // Build as URLSearchParams — Sprout expects form-encoded data (like PHP http_build_query)
  const params = new URLSearchParams();
  params.append('apikey',           apiKey);
  params.append('label-first_name', 'First Name');
  params.append('field-first_name', first);
  params.append('label-last_name',  'Last Name');
  params.append('field-last_name',  last);
  params.append('label-email',      'Email');
  params.append('field-email',      email);
  params.append('label-phone',      'Phone Number');
  params.append('field-phone',      phone);
  // 'type' sets the lead category in Sprout (the dropdown shown on the lead card)
  // Must match Sprout's session type labels exactly (Settings → Lead Forms → Session Types)
  params.append('label-type', 'Shoot Type');
  params.append('field-type', session);
  // Also send as event_type field for the questionnaire detail view
  params.append('label-event_type', 'Session Type');
  params.append('field-event_type', session);
  params.append('label-remark',     'Additional Information');
  params.append('field-remark',     notes);

  try {
    const sproutRes = await fetch('https://api.sproutstudio.com/lead/new', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    const responseText = await sproutRes.text();
    let parsed = null;
    try { parsed = JSON.parse(responseText); } catch { /* not JSON */ }

    console.log('[sprout-proxy] status:', sproutRes.status);
    console.log('[sprout-proxy] response:', responseText.substring(0, 500));
    console.log('[sprout-proxy] sending params:', params.toString());

    if (!sproutRes.ok) {
      return res.status(502).json({
        error:  'Sprout API error',
        status: sproutRes.status,
        detail: parsed || responseText.substring(0, 500),
      });
    }

    if (parsed && parsed.success === false) {
      return res.status(502).json({ error: 'Sprout returned failure', detail: parsed });
    }

    return res.status(200).json({ success: true, data: parsed || { raw: responseText } });

  } catch (err) {
    console.error('[sprout-proxy] fetch error:', err);
    return res.status(500).json({ error: 'Failed to reach Sprout API', detail: err.message });
  }
}
