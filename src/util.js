// Small shared helpers (no dependencies).

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export const err = (message, status = 400) => json({ error: message }, status);

export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Accepts a PNG data URL (from a canvas) and returns the raw bytes.
export function dataUrlToBytes(dataUrl, maxBytes = 600_000) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Signature must be a PNG image.');
  const bin = atob(m[1]);
  if (bin.length > maxBytes) throw new Error('Signature image is too large.');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s.trim());
}

// MM/DD/YYYY in the configured time zone — this is what gets stamped on the contract.
export function fmtDate(d, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// "Oct 6, 2026, 2:29 PM CDT" — used in the audit certificate and emails.
export function fmtDateTime(d, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

export function safeFilename(s, fallback = 'document') {
  const cleaned = String(s || '').replace(/[^\w\s.\-()]/g, '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return cleaned || fallback;
}

export function clientInfo(request) {
  return {
    ip: request.headers.get('cf-connecting-ip') || 'unknown',
    userAgent: (request.headers.get('user-agent') || 'unknown').slice(0, 200),
  };
}
