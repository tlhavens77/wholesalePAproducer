// Owner login: one password (ADMIN_PASSWORD secret) -> signed, expiring cookie.
// Without this, anyone who found the site could send contracts bearing your signature.

const enc = new TextEncoder();
const SESSION_HOURS = 12;

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(env, supplied) {
  if (!env.ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD secret is not set.');
  // Compare HMACs so the comparison is constant-time regardless of length.
  const a = await hmacHex('pw-compare', String(supplied || ''));
  const b = await hmacHex('pw-compare', env.ADMIN_PASSWORD);
  return safeEqual(a, b);
}

export async function sessionCookie(env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sig = await hmacHex(env.ADMIN_PASSWORD, `session.${exp}`);
  return `session=${exp}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

export const clearCookie = 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';

export async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)session=(\d+)\.([a-f0-9]{64})/.exec(cookie);
  if (!m) return false;
  const [, exp, sig] = m;
  if (Number(exp) < Date.now()) return false;
  const expected = await hmacHex(env.ADMIN_PASSWORD, `session.${exp}`);
  return safeEqual(sig, expected);
}
