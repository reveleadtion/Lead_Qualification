// api/sprout.js
// Vercel Serverless Function — proxies lead submission to Sprout Studio API.
// Set SPROUT_API_KEY in Vercel → Settings → Environment Variables.
//
// Sprout lead/new endpoint uses a flat JSON body with label/field pairs.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS
  const origin = req.headers.origin || '';
  const allowed = [
    'https://contact.twowildsoulsphotography.com',
    'https://twowildsoulsphotography.com',
    'http://localhost:3000',
  ];
  if (allowed.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.SPROUT_API_KEY;
  if (!apiKey) {
    console.error('SPROUT_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { first, last, email, phone, session, notes } = req.body || {};

  if (!first || !email) {
    return res.status(400).json({ error: 'First name and email are required' });
  }

  const lead = {
    apikey:              apiKey,
    'label-first_name': 'First Name',
    'field-first_name':  first,
    'label-last_name':  'Last Name',
    'field-last_name':   last || '',
    'label-email':      'Email',
    'field-email':       email,
  };

  if (phone) {
    lead['label-phone'] = 'Phone';
    lead['field-phone'] = phone;
  }
  if (session) {
    lead['label-event_type'] = 'Session Type';
    lead['field-event_type'] = session;
  }
  if (notes) {
    lead['label-remark'] = 'Additional Information';
    lead['field-remark'] = notes;
  }

  try {
    const sproutRes = await fetch('https://api.sproutstudio.com/lead/new', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(lead),
    });

    const text = await sproutRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!sproutRes.ok) {
      console.error('Sprout error:', sproutRes.status, text);
      return res.status(502).json({ error: 'Sprout API error', detail: text });
    }

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Failed to reach Sprout API' });
  }
}
