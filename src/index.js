// Contract Signer — Cloudflare Worker.
//
//   Owner (password protected):  /admin
//   Recipient (private link):    /sign/<token>
//
// Storage: KV (binding DB) for records, R2 (binding FILES) for PDFs.

import { json, err, randomHex, sha256Hex, dataUrlToBytes, bytesToBase64, isEmail, fmtDate, fmtDateTime, safeFilename, clientInfo } from './util.js';
import { checkPassword, sessionCookie, clearCookie, isAdmin } from './auth.js';
import { sendEmail, signRequestEmail, signedCopyEmail } from './email.js';
import { FIELD_TYPES, loadPdf, stampSender, finalizeSigned, appendSignaturePage } from './pdf.js';
import { docxToPdf } from './docx.js';

const MAX_UPLOAD = 20 * 1024 * 1024;
const DRAFT_TTL = 7 * 24 * 3600;

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://cdnjs.cloudflare.com; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  // The signing link contains a secret token, so never let it leak in a Referer header.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error(e);
      return err(e.message || 'Server error', 500);
    }
  },
};

// ---------------------------------------------------------------- routing
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/') return Response.redirect(`${url.origin}/admin`, 302);
  if (path === '/admin') return asset(request, env, '/admin.html');
  if (/^\/sign\/[a-f0-9]{64}$/.test(path)) return asset(request, env, '/sign.html');

  if (!path.startsWith('/api/')) return asset(request, env, path);

  // ---- public: auth
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie });

  // ---- public: recipient signing (secured by the secret token in the URL)
  let m;
  if ((m = /^\/api\/sign\/([a-f0-9]{64})(?:\/(pdf|download))?$/.exec(path))) {
    const token = m[1];
    if (!m[2] && method === 'GET') return signInfo(request, env, token);
    if (!m[2] && method === 'POST') return signSubmit(request, env, token);
    if (m[2] === 'pdf' && method === 'GET') return signPdf(env, token, false);
    if (m[2] === 'download' && method === 'GET') return signPdf(env, token, true);
    return err('Not found', 404);
  }

  // ---- everything below is owner-only
  if (!(await isAdmin(request, env))) {
    if (path === '/api/me') return json({ authed: false });
    return err('Please log in.', 401);
  }

  if (path === '/api/me') return json({ authed: true });
  if (path === '/api/settings' && method === 'GET') return getSettingsApi(env);
  if (path === '/api/settings' && method === 'PUT') return putSettings(request, env);
  if (path === '/api/upload-prepare' && method === 'POST') return uploadPrepare(request, env);
  if ((m = /^\/api\/draft\/([a-f0-9]{32})\/pdf$/.exec(path)) && method === 'GET') return pdfResponse(await env.FILES.get(`drafts/${m[1]}.pdf`), 'draft.pdf', false);
  if (path === '/api/send' && method === 'POST') return sendAgreement(request, env);
  if (path === '/api/agreements' && method === 'GET') return listAgreements(env, request);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})\/pdf$/.exec(path)) && method === 'GET') return agreementPdf(env, m[1], url.searchParams);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})\/resend$/.exec(path)) && method === 'POST') return resend(request, env, m[1]);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})\/void$/.exec(path)) && method === 'POST') return voidAgreement(env, m[1]);

  return err('Not found', 404);
}

async function asset(request, env, path) {
  const u = new URL(request.url);
  u.pathname = path;
  const res = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET', headers: request.headers }));
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  if (path.endsWith('.html')) h.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}

const tz = (env) => env.TIMEZONE || 'America/Chicago';
const origin = (request, env) => env.PUBLIC_URL || new URL(request.url).origin;
const getJson = async (env, key) => JSON.parse((await env.DB.get(key)) || 'null');

function pdfResponse(obj, filename, download) {
  if (!obj) return err('File not found.', 404);
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${safeFilename(filename).replace(/"/g, '')}.pdf"`,
      'cache-control': 'private, no-store',
    },
  });
}

// ---------------------------------------------------------------- auth
async function login(request, env) {
  const { password } = await request.json().catch(() => ({}));
  let ok = false;
  try { ok = await checkPassword(env, password); } catch (e) { return err(e.message, 500); }
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return err('Wrong password.', 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env) });
}

// ---------------------------------------------------------------- settings (owner name, email, signature)
async function getSettingsApi(env) {
  const s = (await getJson(env, 'settings')) || {};
  return json({ name: s.name || '', email: s.email || '', signature: s.signature || '' });
}

async function putSettings(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  if (name.length < 2 || name.length > 100) return err('Enter your full name.');
  if (!isEmail(email)) return err('Enter a valid email address.');
  const prev = (await getJson(env, 'settings')) || {};
  let signature = prev.signature || '';
  if (b.signature) {
    try { dataUrlToBytes(b.signature); } catch (e) { return err(e.message); }
    signature = b.signature;
  }
  if (!signature) return err('Draw or type your signature.');
  await env.DB.put('settings', JSON.stringify({ name, email, signature }));
  return json({ ok: true });
}

// ---------------------------------------------------------------- step 1: upload + prepare
async function uploadPrepare(request, env) {
  const settings = await getJson(env, 'settings');
  if (!settings?.signature || !settings?.name) return err('Set up your name and signature first (Settings).');

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return err('Choose a PDF or Word file to upload.');
  if (file.size > MAX_UPLOAD) return err('That file is larger than 20 MB.');

  const recipientName = String(form.get('recipientName') || '').trim();
  const recipientEmail = String(form.get('recipientEmail') || '').trim();
  const ownerEmail = String(form.get('ownerEmail') || '').trim();
  const label = String(form.get('label') || '').trim();
  const message = String(form.get('message') || '').trim();
  if (!recipientName || recipientName.length > 100) return err("Enter the recipient's name.");
  if (!isEmail(recipientEmail)) return err("Enter a valid recipient email.");
  if (!isEmail(ownerEmail)) return err('Enter a valid email for your signed copy.');
  if (!label || label.length > 150) return err('Enter the property address or a title for this agreement.');
  if (message.length > 1000) return err('The message is too long (1000 characters max).');

  const raw = new Uint8Array(await file.arrayBuffer());
  const isPdf = raw[0] === 0x25 && raw[1] === 0x50 && raw[2] === 0x44 && raw[3] === 0x46; // %PDF
  const isZip = raw[0] === 0x50 && raw[1] === 0x4b;
  let pdfBytes;
  if (isPdf) pdfBytes = raw;
  else if (isZip && /\.docx$/i.test(file.name || '')) pdfBytes = await docxToPdf(raw);
  else return err('Please upload a PDF or a Word .docx file. (For an older .doc file, save it as .docx or PDF first.)');

  let doc = await loadPdf(pdfBytes);
  if (doc.getPageCount() > 100) return err('That document has more than 100 pages.');

  let fields = [];
  if (form.get('appendSignaturePage') === 'true') {
    const r = await appendSignaturePage(pdfBytes, { ownerName: settings.name, recipientName, label });
    pdfBytes = r.bytes;
    fields = r.fields;
    doc = await loadPdf(pdfBytes);
  }

  const draftId = randomHex(16);
  await env.FILES.put(`drafts/${draftId}.pdf`, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } });
  await env.DB.put(`draft:${draftId}`, JSON.stringify({ recipientName, recipientEmail, ownerEmail, label, message, pageCount: doc.getPageCount(), createdAt: Date.now() }), { expirationTtl: DRAFT_TTL });
  return json({ draftId, pageCount: doc.getPageCount(), fields, converted: !isPdf });
}

// ---------------------------------------------------------------- step 2: place fields, stamp sender, send
function cleanFields(input, pageCount) {
  if (!Array.isArray(input) || input.length > 40) throw new Error('Invalid field list.');
  return input.map((f) => {
    if (!FIELD_TYPES[f.type]) throw new Error('Unknown field type.');
    const n = (v) => Number(v);
    const page = n(f.page);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) throw new Error('Field is on a page that does not exist.');
    const out = { id: crypto.randomUUID(), type: f.type, page, x: n(f.x), y: n(f.y), w: n(f.w), h: n(f.h) };
    for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(out[k]) || out[k] < 0 || out[k] > 1) throw new Error('Field position is out of bounds.');
    if (out.w <= 0 || out.h <= 0) throw new Error('Field has no size.');
    return out;
  });
}

async function sendAgreement(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{32}$/.test(body.draftId || '')) return err('Missing draft.');
  const draft = await getJson(env, `draft:${body.draftId}`);
  if (!draft) return err('This draft expired. Please upload the document again.', 404);
  const settings = await getJson(env, 'settings');
  if (!settings?.signature) return err('Set up your name and signature first (Settings).');

  let fields;
  try { fields = cleanFields(body.fields, draft.pageCount); } catch (e) { return err(e.message); }
  if (!fields.some((f) => f.type === 'recipient_signature')) return err('Place at least one recipient signature box.');

  const obj = await env.FILES.get(`drafts/${body.draftId}.pdf`);
  if (!obj) return err('The uploaded file is gone. Please upload it again.', 404);
  const original = new Uint8Array(await obj.arrayBuffer());

  const now = new Date();
  const sentBytes = await stampSender(original, fields, {
    signaturePng: dataUrlToBytes(settings.signature),
    name: settings.name,
    dateText: fmtDate(now, tz(env)),
  });
  const sentHash = await sha256Hex(sentBytes);

  const id = crypto.randomUUID();
  const token = randomHex(32);
  const link = `${origin(request, env)}/sign/${token}`;
  const pdfMeta = { httpMetadata: { contentType: 'application/pdf' } };
  await env.FILES.put(`agreements/${id}/original.pdf`, original, pdfMeta);
  await env.FILES.put(`agreements/${id}/sent.pdf`, sentBytes, pdfMeta);

  try {
    const mail = signRequestEmail({ ownerName: settings.name, label: draft.label, link, message: draft.message });
    await sendEmail(env, { to: draft.recipientEmail, subject: `Please sign: ${draft.label}`, replyTo: draft.ownerEmail, ...mail });
  } catch (e) {
    await env.FILES.delete([`agreements/${id}/original.pdf`, `agreements/${id}/sent.pdf`]);
    return err(`The email could not be sent, so nothing was created. ${e.message}`, 502);
  }

  const record = {
    id, token, status: 'sent', label: draft.label, message: draft.message,
    owner: { name: settings.name, email: draft.ownerEmail },
    recipient: { name: draft.recipientName, email: draft.recipientEmail },
    fields, pageCount: draft.pageCount, sentHash,
    createdAt: now.toISOString(), sentAt: now.toISOString(),
    senderAudit: clientInfo(request),
  };
  await env.DB.put(`agr:${id}`, JSON.stringify(record));
  await env.DB.put(`tok:${token}`, id);
  await env.DB.delete(`draft:${body.draftId}`);
  await env.FILES.delete(`drafts/${body.draftId}.pdf`);
  return json({ ok: true, id, link });
}

// ---------------------------------------------------------------- owner dashboard
async function listAgreements(env, request) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'agr:', cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const records = (await Promise.all(keys.map((k) => getJson(env, k.name)))).filter(Boolean);
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const base = origin(request, env);
  return json({
    agreements: records.map((r) => ({
      id: r.id, label: r.label, status: r.status, owner: r.owner, recipient: r.recipient,
      createdAt: r.createdAt, viewedAt: r.viewedAt || null, completedAt: r.completedAt || null,
      link: r.status === 'sent' ? `${base}/sign/${r.token}` : null,
      emailErrors: r.emailErrors || [],
    })),
  });
}

async function agreementPdf(env, id, params) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  const kind = ['original', 'sent', 'signed'].includes(params.get('kind')) ? params.get('kind') : 'signed';
  const suffix = kind === 'signed' ? 'Signed' : kind === 'sent' ? 'Sent' : 'Original';
  return pdfResponse(await env.FILES.get(`agreements/${id}/${kind}.pdf`), `${r.label} - ${suffix}`, params.get('download') === '1');
}

async function voidAgreement(env, id) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  if (r.status !== 'sent') return err('Only agreements that are waiting for a signature can be voided.');
  r.status = 'void';
  r.voidedAt = new Date().toISOString();
  await env.DB.put(`agr:${id}`, JSON.stringify(r));
  return json({ ok: true });
}

async function resend(request, env, id) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  try {
    if (r.status === 'sent') {
      const link = `${origin(request, env)}/sign/${r.token}`;
      const mail = signRequestEmail({ ownerName: r.owner.name, label: r.label, link, message: r.message });
      await sendEmail(env, { to: r.recipient.email, subject: `Reminder — please sign: ${r.label}`, replyTo: r.owner.email, ...mail });
      return json({ ok: true, message: `Reminder sent to ${r.recipient.email}.` });
    }
    if (r.status === 'completed') {
      const errors = await emailSignedCopies(env, r);
      if (errors.length) return err(errors.join(' '), 502);
      return json({ ok: true, message: 'Signed copies re-sent to both parties.' });
    }
  } catch (e) {
    return err(e.message, 502);
  }
  return err('This agreement was voided.');
}

// ---------------------------------------------------------------- recipient: view + sign
async function byToken(env, token) {
  const id = await env.DB.get(`tok:${token}`);
  return id ? getJson(env, `agr:${id}`) : null;
}

async function signInfo(request, env, token) {
  const r = await byToken(env, token);
  if (!r) return err('This link is not valid.', 404);
  if (r.status === 'sent' && !r.viewedAt) {
    r.viewedAt = new Date().toISOString();
    r.recipientViewAudit = clientInfo(request);
    await env.DB.put(`agr:${r.id}`, JSON.stringify(r));
  }
  return json({
    status: r.status, label: r.label, ownerName: r.owner.name, recipientName: r.recipient.name,
    pageCount: r.pageCount, completedAt: r.completedAt || null,
    fields: r.fields.filter((f) => f.type.startsWith('recipient_')),
  });
}

async function signPdf(env, token, download) {
  const r = await byToken(env, token);
  if (!r) return err('This link is not valid.', 404);
  if (r.status === 'void') return err('This agreement is no longer available.', 410);
  if (download && r.status !== 'completed') return err('This agreement has not been signed yet.', 409);
  const kind = r.status === 'completed' ? 'signed' : 'sent';
  return pdfResponse(await env.FILES.get(`agreements/${r.id}/${kind}.pdf`), `${r.label} - ${kind === 'signed' ? 'Signed' : 'To sign'}`, download);
}

async function signSubmit(request, env, token) {
  const r = await byToken(env, token);
  if (!r) return err('This link is not valid.', 404);
  if (r.status === 'completed') return err('This agreement has already been signed.', 409);
  if (r.status !== 'sent') return err('This agreement is no longer available.', 410);

  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 100) return err('Please type your full name.');
  if (b.consent !== true) return err('Please confirm you agree to sign electronically.');
  let sigPng;
  try { sigPng = dataUrlToBytes(b.signature); } catch (e) { return err('Please add your signature.'); }

  const sentObj = await env.FILES.get(`agreements/${r.id}/sent.pdf`);
  if (!sentObj) return err('The document is missing. Contact the sender.', 500);
  const sentBytes = new Uint8Array(await sentObj.arrayBuffer());

  const now = new Date();
  const zone = tz(env);
  const info = clientInfo(request);
  const stamp = (d) => `${fmtDateTime(d, zone)}  (${d.toISOString()})`;

  const certificate = {
    sections: [
      { heading: 'Document', rows: [
        ['Agreement', r.label],
        ['Agreement ID', r.id],
        ['Fingerprint', `SHA-256 of the document as sent for signature: ${r.sentHash}`],
      ] },
      { heading: 'Sender', rows: [
        ['Name', r.owner.name],
        ['Email', r.owner.email],
        ['Signed', stamp(new Date(r.sentAt))],
        ['IP address', r.senderAudit?.ip || 'unknown'],
      ] },
      { heading: 'Recipient', rows: [
        ['Name', name],
        ['Email', r.recipient.email],
        ['Link first opened', r.viewedAt ? stamp(new Date(r.viewedAt)) : 'n/a'],
        ['Signed', stamp(now)],
        ['IP address', info.ip],
        ['Browser', info.userAgent],
        ['Consent', 'Agreed to use electronic records and signatures before signing.'],
      ] },
    ],
    footnote:
      'This certificate was generated automatically when the final signature was applied. The signers consented to sign electronically; ' +
      'electronic signatures are intended to be binding under the U.S. ESIGN Act and UETA. Any change to the document after signing ' +
      'can be detected by comparing the fingerprint above with the document as sent.',
  };

  const signedBytes = await finalizeSigned(sentBytes, r.fields, { signaturePng: sigPng, name, dateText: fmtDate(now, zone) }, certificate);
  await env.FILES.put(`agreements/${r.id}/signed.pdf`, signedBytes, { httpMetadata: { contentType: 'application/pdf' } });

  r.status = 'completed';
  r.completedAt = now.toISOString();
  r.recipient.signedName = name;
  r.recipientAudit = info;
  r.signedHash = await sha256Hex(signedBytes);
  r.emailErrors = await emailSignedCopies(env, r, signedBytes);
  await env.DB.put(`agr:${r.id}`, JSON.stringify(r));

  return json({ ok: true, emailed: r.emailErrors.length === 0 });
}

// Emails the signed PDF to the owner and the recipient. Returns a list of error strings (empty = all good).
async function emailSignedCopies(env, r, bytes) {
  if (!bytes) {
    const obj = await env.FILES.get(`agreements/${r.id}/signed.pdf`);
    if (!obj) return ['Signed file not found.'];
    bytes = new Uint8Array(await obj.arrayBuffer());
  }
  const attachments = [{ filename: `${safeFilename(r.label)} - Signed.pdf`, content: bytesToBase64(bytes) }];
  const whenText = fmtDateTime(new Date(r.completedAt || Date.now()), tz(env));
  const errors = [];
  for (const audience of ['owner', 'recipient']) {
    try {
      const mail = signedCopyEmail({ audience, ownerName: r.owner.name, recipientName: r.recipient.signedName || r.recipient.name, label: r.label, whenText });
      await sendEmail(env, {
        to: audience === 'owner' ? r.owner.email : r.recipient.email,
        subject: audience === 'owner' ? `Signed: ${r.label}` : `Your signed copy: ${r.label}`,
        attachments,
        ...mail,
      });
    } catch (e) {
      errors.push(`Could not email ${audience === 'owner' ? 'you' : 'the recipient'}: ${e.message}`);
    }
  }
  return errors;
}
