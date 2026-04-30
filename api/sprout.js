// api/sprout.js
// Vercel Serverless Function — proxies lead submission to Sprout Studio API.
// Set SPROUT_API_KEY in Vercel → Settings → Environment Variables.
//
// Sprout's lead/new endpoint accepts label-X / field-X pairs that map to
// the lead form's configured fields. Standard field names per Sprout's
// documentation: first_name, last_name, email, phone, event_type, remark.

export default async function handler(req, res) {
  // CORS — allow your domain + Vercel previews + localhost
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
    return res.status(500).json({
      error:  'Server configuration error',
      detail: 'SPROUT_API_KEY missing from environment',
    });
  }

  // Parse body — Vercel auto-parses JSON when content-type is application/json
  const body = req.body || {};
  const first   = (body.first   || '').toString().trim();
  const last    = (body.last    || '').toString().trim();
  const email   = (body.email   || '').toString().trim();
  const phone   = (body.phone   || '').toString().trim();
  const session = (body.session || '').toString().trim();
  const notes   = (body.notes   || '').toString().trim();

  if (!first || !email) {
    return res.status(400).json({
      error:  'Missing required fields',
      detail: 'first name and email are required',
    });
  }

  // Build Sprout payload using standard field names from their PHP example
  const payload = {
    apikey:              apiKey,
    'label-first_name': 'First Name',
    'field-first_name':  first,
    'label-last_name':  'Last Name',
    'field-last_name':   last,
    'label-email':      'Email',
    'field-email':       email,
    'label-phone':      'Phone',
    'field-phone':       phone,
    'label-event_type': 'Session Type',
    'field-event_type':  session,
    'label-remark':     'Additional Information',
    'field-remark':      notes,
  };

  try {
    const sproutRes = await fetch('https://api.sproutstudio.com/lead/new', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const responseText = await sproutRes.text();
    let parsed = null;
    try { parsed = JSON.parse(responseText); } catch { /* not JSON */ }

    // Log everything for debugging — visible in Vercel function logs
    console.log('[sprout-proxy] status:', sproutRes.status);
    console.log('[sprout-proxy] response:', responseText.substring(0, 500));

    if (!sproutRes.ok) {
      return res.status(502).json({
        error:  'Sprout API rejected the request',
        status: sproutRes.status,
        detail: parsed || responseText.substring(0, 500),
      });
    }

    // Sprout returns 200 even on logical failures — check the body
    if (parsed && parsed.success === false) {
      return res.status(502).json({
        error:  'Sprout returned failure',
        detail: parsed,
      });
    }

    return res.status(200).json({
      success: true,
      data: parsed || { raw: responseText },
    });

  } catch (err) {
    console.error('[sprout-proxy] fetch error:', err);
    return res.status(500).json({
      error:  'Failed to reach Sprout API',
      detail: err.message,
    });
  }
}
