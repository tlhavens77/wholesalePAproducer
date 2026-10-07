// Contract Signer — Cloudflare Worker.
//
//   Owner (password protected):  /admin
//   Recipients (private links):  /sign/<token>      (one link per signer, up to two signers)
//
// Storage: KV (binding DB) for records, R2 (binding FILES) for PDFs.

import { json, err, randomHex, sha256Hex, dataUrlToBytes, bytesToBase64, isEmail, fmtDate, fmtDateTime, safeFilename, clientInfo } from './util.js';
import { checkPassword, sessionCookie, clearCookie, isAdmin } from './auth.js';
import { sendEmail, signRequestEmail, signedCopyEmail, signedProgressEmail } from './email.js';
import { FIELD_TYPES, loadPdf, stampSender, stampRecipients, appendSignaturePage } from './pdf.js';
import { docxToPdf } from './docx.js';

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_RECIPIENTS = 2;
const DRAFT_TTL = 7 * 24 * 3600;
const PDF_META = { httpMetadata: { contentType: 'application/pdf' } };

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; worker-src 'self' blob: https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://cdnjs.cloudflare.com; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  // The signing links contain a secret token, so never let them leak in a Referer header.
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
  if ((m = /^\/api\/draft\/([a-f0-9]{32})\/pdf$/.exec(path)) && method === 'GET') return pdfResponse(await env.FILES.get(`drafts/${m[1]}.pdf`), 'draft', false);
  if ((m = /^\/api\/draft\/([a-f0-9]{32})$/.exec(path)) && method === 'GET') {
    const d = await getJson(env, `draft:${m[1]}`);
    return d ? json({ recipients: d.recipients, pageCount: d.pageCount }) : err('Draft expired.', 404);
  }
  if (path === '/api/send' && method === 'POST') return sendAgreement(request, env);
  if (path === '/api/agreements' && method === 'GET') return listAgreements(env, request);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})\/pdf$/.exec(path)) && method === 'GET') return agreementPdf(env, m[1], url.searchParams);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})\/resend$/.exec(path)) && method === 'POST') return resend(request, env, m[1]);
  if ((m = /^\/api\/agreements\/([a-f0-9-]{36})$/.exec(path)) && method === 'DELETE') return deleteAgreement(env, m[1]);
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
const putJson = (env, key, value) => env.DB.put(key, JSON.stringify(value));
const readBytes = async (obj) => new Uint8Array(await obj.arrayBuffer());
const linkFor = (request, env, token) => `${origin(request, env)}/sign/${token}`;

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

// ---------------------------------------------------------------- settings (owner name, email, signature, initials)
async function getSettingsApi(env) {
  const s = (await getJson(env, 'settings')) || {};
  return json({ name: s.name || '', email: s.email || '', signature: s.signature || '', initials: s.initials || '' });
}

async function putSettings(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim();
  if (name.length < 2 || name.length > 100) return err('Enter your full name.');
  if (!isEmail(email)) return err('Enter a valid email address.');
  const prev = (await getJson(env, 'settings')) || {};
  let { signature = '', initials = '' } = prev;
  try {
    if (b.signature) { dataUrlToBytes(b.signature); signature = b.signature; }
    if (b.initials) { dataUrlToBytes(b.initials); initials = b.initials; }
  } catch (e) { return err(e.message); }
  if (!signature) return err('Draw or type your signature.');
  await putJson(env, 'settings', { name, email, signature, initials });
  return json({ ok: true });
}

// ---------------------------------------------------------------- step 1: upload + prepare
function parseRecipients(form) {
  const recipients = [];
  for (const suffix of ['', '2']) {
    const name = String(form.get(`recipient${suffix}Name`) || '').trim();
    const email = String(form.get(`recipient${suffix}Email`) || '').trim();
    if (!name && !email) {
      if (suffix === '') throw new Error("Enter the recipient's name and email.");
      continue;
    }
    const who = suffix ? 'second recipient' : 'recipient';
    if (!name || name.length > 100) throw new Error(`Enter the ${who}'s name.`);
    if (!isEmail(email)) throw new Error(`Enter a valid email for the ${who}.`);
    recipients.push({ name, email });
  }
  return recipients;
}

async function uploadPrepare(request, env) {
  const settings = await getJson(env, 'settings');
  if (!settings?.signature || !settings?.name) return err('Set up your name and signature first (My signature).');

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.arrayBuffer) return err('Choose a PDF or Word file to upload.');
  if (file.size > MAX_UPLOAD) return err('That file is larger than 20 MB.');

  let recipients;
  try { recipients = parseRecipients(form); } catch (e) { return err(e.message); }
  const ownerEmail = String(form.get('ownerEmail') || '').trim();
  const label = String(form.get('label') || '').trim();
  const message = String(form.get('message') || '').trim();
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
    const r = await appendSignaturePage(pdfBytes, { ownerName: settings.name, recipients, label });
    pdfBytes = r.bytes;
    fields = r.fields;
    doc = await loadPdf(pdfBytes);
  }

  const draftId = randomHex(16);
  await env.FILES.put(`drafts/${draftId}.pdf`, pdfBytes, PDF_META);
  await env.DB.put(`draft:${draftId}`, JSON.stringify({ recipients, ownerEmail, label, message, pageCount: doc.getPageCount(), createdAt: Date.now() }), { expirationTtl: DRAFT_TTL });
  return json({ draftId, pageCount: doc.getPageCount(), recipients, fields, converted: !isPdf });
}

// ---------------------------------------------------------------- step 2: place fields, stamp sender, send
function cleanFields(input, pageCount, recipientCount) {
  if (!Array.isArray(input) || input.length > 120) throw new Error('Invalid field list.');
  return input.map((f) => {
    if (!FIELD_TYPES[f.type]) throw new Error('Unknown field type.');
    const n = (v) => Number(v);
    const page = n(f.page);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) throw new Error('A box is on a page that does not exist.');
    const out = { id: crypto.randomUUID(), type: f.type, page, x: n(f.x), y: n(f.y), w: n(f.w), h: n(f.h) };
    for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(out[k]) || out[k] < 0 || out[k] > 1) throw new Error('A box position is out of bounds.');
    if (out.w <= 0 || out.h <= 0) throw new Error('A box has no size.');
    if (f.type.startsWith('recipient_')) {
      const signer = Number(f.signer ?? 0);
      if (!Number.isInteger(signer) || signer < 0 || signer >= recipientCount) throw new Error('A box belongs to a recipient that does not exist.');
      out.signer = signer;
    }
    return out;
  });
}

async function sendAgreement(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{32}$/.test(body.draftId || '')) return err('Missing draft.');
  const draft = await getJson(env, `draft:${body.draftId}`);
  if (!draft) return err('This draft expired. Please upload the document again.', 404);
  const settings = await getJson(env, 'settings');
  if (!settings?.signature) return err('Set up your name and signature first (My signature).');

  let fields;
  try { fields = cleanFields(body.fields, draft.pageCount, draft.recipients.length); } catch (e) { return err(e.message); }
  for (let i = 0; i < draft.recipients.length; i++) {
    if (!fields.some((f) => f.type === 'recipient_signature' && f.signer === i)) {
      return err(`Place at least one signature box for ${draft.recipients[i].name}.`);
    }
  }
  if (fields.some((f) => f.type === 'sender_initials') && !settings.initials) {
    return err('You placed your initials, but none are saved yet. Add them under My signature.');
  }

  const obj = await env.FILES.get(`drafts/${body.draftId}.pdf`);
  if (!obj) return err('The uploaded file is gone. Please upload it again.', 404);
  const original = await readBytes(obj);

  const now = new Date();
  const sentBytes = await stampSender(original, fields, {
    signaturePng: dataUrlToBytes(settings.signature),
    initialsPng: settings.initials ? dataUrlToBytes(settings.initials) : null,
    name: settings.name,
    dateText: fmtDate(now, tz(env)),
  });
  const sentHash = await sha256Hex(sentBytes);

  const id = crypto.randomUUID();
  await env.FILES.put(`agreements/${id}/original.pdf`, original, PDF_META);
  await env.FILES.put(`agreements/${id}/sent.pdf`, sentBytes, PDF_META);

  const recipients = draft.recipients.map((r) => ({ name: r.name, email: r.email, token: randomHex(32), signed: false }));
  const record = {
    id, status: 'sent', label: draft.label, message: draft.message,
    owner: { name: settings.name, email: draft.ownerEmail },
    recipients, fields, pageCount: draft.pageCount, sentHash,
    createdAt: now.toISOString(), sentAt: now.toISOString(),
    senderAudit: clientInfo(request), emailErrors: [],
  };
  await putJson(env, `agr:${id}`, record);
  for (let i = 0; i < recipients.length; i++) await putJson(env, `tok:${recipients[i].token}`, { id, i });
  await env.DB.delete(`draft:${body.draftId}`);
  await env.FILES.delete(`drafts/${body.draftId}.pdf`);

  // Email every recipient. A failure here doesn't lose the agreement: the links are returned so you can send them yourself.
  const errors = [];
  for (const r of recipients) {
    try {
      const mail = signRequestEmail({ ownerName: settings.name, label: draft.label, link: linkFor(request, env, r.token), message: draft.message });
      await sendEmail(env, { to: r.email, subject: `Please sign: ${draft.label}`, replyTo: draft.ownerEmail, ...mail });
    } catch (e) {
      errors.push(`Could not email ${r.name}: ${e.message}`);
    }
  }
  if (errors.length) {
    record.emailErrors = errors;
    await putJson(env, `agr:${id}`, record);
  }
  return json({
    ok: true, id, emailErrors: errors,
    links: recipients.map((r) => ({ name: r.name, email: r.email, link: linkFor(request, env, r.token) })),
  });
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
  return json({
    agreements: records.map((r) => ({
      id: r.id, label: r.label, status: r.status, owner: r.owner,
      createdAt: r.createdAt, completedAt: r.completedAt || null,
      recipients: r.recipients.map((x) => ({
        name: x.name, email: x.email, signed: !!x.signed, signedAt: x.signedAt || null, viewedAt: x.viewedAt || null,
        link: r.status === 'sent' && !x.signed ? linkFor(request, env, x.token) : null,
      })),
      emailErrors: r.emailErrors || [],
    })),
  });
}

async function agreementPdf(env, id, params) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  const kind = ['original', 'latest', 'signed'].includes(params.get('kind')) ? params.get('kind') : 'signed';
  let obj;
  if (kind === 'latest') obj = (await env.FILES.get(`agreements/${id}/current.pdf`)) || (await env.FILES.get(`agreements/${id}/sent.pdf`));
  else obj = await env.FILES.get(`agreements/${id}/${kind}.pdf`);
  const suffix = kind === 'signed' ? 'Signed' : kind === 'latest' ? 'Current' : 'Original';
  return pdfResponse(obj, `${r.label} - ${suffix}`, params.get('download') === '1');
}

// Permanently removes an agreement: its record, signing links and every stored PDF.
async function deleteAgreement(env, id) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  for (const x of r.recipients || []) if (x.token) await env.DB.delete(`tok:${x.token}`);
  const names = ['original', 'sent', 'current', 'signed'].map((n) => `agreements/${id}/${n}.pdf`);
  for (let i = 0; i < 2; i++) names.push(`agreements/${id}/signer-${i}.json`);
  await env.FILES.delete(names);
  await env.DB.delete(`agr:${id}`);
  return json({ ok: true, message: 'Agreement deleted.' });
}

async function voidAgreement(env, id) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  if (r.status !== 'sent') return err('Only agreements that are waiting for signatures can be voided.');
  r.status = 'void';
  r.voidedAt = new Date().toISOString();
  await putJson(env, `agr:${id}`, r);
  return json({ ok: true });
}

async function resend(request, env, id) {
  const r = await getJson(env, `agr:${id}`);
  if (!r) return err('Not found', 404);
  try {
    if (r.status === 'sent') {
      const pending = r.recipients.filter((x) => !x.signed);
      for (const x of pending) {
        const mail = signRequestEmail({ ownerName: r.owner.name, label: r.label, link: linkFor(request, env, x.token), message: r.message });
        await sendEmail(env, { to: x.email, subject: `Reminder — please sign: ${r.label}`, replyTo: r.owner.email, ...mail });
      }
      return json({ ok: true, message: `Reminder sent to ${pending.map((x) => x.email).join(' and ')}.` });
    }
    if (r.status === 'completed') {
      const errors = await emailSignedCopies(env, r);
      if (errors.length) return err(errors.join(' '), 502);
      return json({ ok: true, message: 'Signed copies re-sent to everyone.' });
    }
  } catch (e) {
    return err(e.message, 502);
  }
  return err('This agreement was voided.');
}

// ---------------------------------------------------------------- recipients: view + sign
async function byToken(env, token) {
  const t = await getJson(env, `tok:${token}`);
  if (!t) return null;
  const r = await getJson(env, `agr:${t.id}`);
  return r && r.recipients[t.i] ? { r, i: t.i } : null;
}

async function signInfo(request, env, token) {
  const found = await byToken(env, token);
  if (!found) return err('This link is not valid.', 404);
  const { r, i } = found;
  const me = r.recipients[i];
  if (r.status === 'sent' && !me.signed && !me.viewedAt) {
    me.viewedAt = new Date().toISOString();
    me.viewAudit = clientInfo(request);
    await putJson(env, `agr:${r.id}`, r);
  }
  const mine = r.fields.filter((f) => f.type.startsWith('recipient_') && (f.signer || 0) === i);
  return json({
    status: r.status, label: r.label, ownerName: r.owner.name,
    signerName: me.name, signed: !!me.signed, completedAt: r.completedAt || null,
    needsInitials: mine.some((f) => f.type === 'recipient_initials'),
    waitingOn: r.recipients.filter((x, k) => k !== i && !x.signed).map((x) => x.name),
    fields: mine,
  });
}

async function signPdf(env, token, download) {
  const found = await byToken(env, token);
  if (!found) return err('This link is not valid.', 404);
  const { r } = found;
  if (r.status === 'void') return err('This agreement is no longer available.', 410);
  if (download && r.status !== 'completed') return err('This agreement has not been fully signed yet.', 409);
  let obj;
  if (r.status === 'completed') obj = await env.FILES.get(`agreements/${r.id}/signed.pdf`);
  else obj = (await env.FILES.get(`agreements/${r.id}/current.pdf`)) || (await env.FILES.get(`agreements/${r.id}/sent.pdf`));
  return pdfResponse(obj, `${r.label} - ${r.status === 'completed' ? 'Signed' : 'To sign'}`, download);
}

async function signSubmit(request, env, token) {
  const found = await byToken(env, token);
  if (!found) return err('This link is not valid.', 404);
  const { r, i } = found;
  if (r.status === 'void') return err('This agreement is no longer available.', 410);
  if (r.status === 'completed' || r.recipients[i].signed) return err('You have already signed this document.', 409);

  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 100) return err('Please type your full name.');
  if (b.consent !== true) return err('Please confirm you agree to sign electronically.');
  let sigPng;
  try { sigPng = dataUrlToBytes(b.signature); } catch (e) { return err('Please add your signature.'); }
  const needsInitials = r.fields.some((f) => f.type === 'recipient_initials' && (f.signer || 0) === i);
  let iniPng = null;
  if (needsInitials) {
    try { iniPng = dataUrlToBytes(b.initials); } catch (e) { return err('Please add your initials.'); }
  }

  const sentObj = await env.FILES.get(`agreements/${r.id}/sent.pdf`);
  if (!sentObj) return err('The document is missing. Contact the sender.', 500);
  const sentBytes = await readBytes(sentObj);

  const now = new Date();
  const zone = tz(env);
  const info = clientInfo(request);
  const stamp = (d) => `${fmtDateTime(d, zone)}  (${d.toISOString()})`;
  const dateText = fmtDate(now, zone);

  // Remember this signer's marks so the PDF can always be rebuilt from the "as sent" file.
  await env.FILES.put(`agreements/${r.id}/signer-${i}.json`, JSON.stringify({ signature: b.signature, initials: needsInitials ? b.initials : null, name, dateText }));

  const me = r.recipients[i];
  me.signed = true;
  me.signedName = name;
  me.signedAt = now.toISOString();
  me.audit = info;
  const allDone = r.recipients.every((x) => x.signed);

  const signers = [];
  for (let k = 0; k < r.recipients.length; k++) {
    if (!r.recipients[k].signed) continue;
    if (k === i) { signers.push({ index: k, signaturePng: sigPng, initialsPng: iniPng, name, dateText }); continue; }
    const saved = JSON.parse(await (await env.FILES.get(`agreements/${r.id}/signer-${k}.json`)).text());
    signers.push({ index: k, signaturePng: dataUrlToBytes(saved.signature), initialsPng: saved.initials ? dataUrlToBytes(saved.initials) : null, name: saved.name, dateText: saved.dateText });
  }

  let certificate = null;
  if (allDone) {
    certificate = {
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
        ...r.recipients.map((x, k) => ({
          heading: r.recipients.length > 1 ? `Recipient ${k + 1}` : 'Recipient',
          rows: [
            ['Name', x.signedName],
            ['Email', x.email],
            ['Link first opened', x.viewedAt ? stamp(new Date(x.viewedAt)) : 'n/a'],
            ['Signed', stamp(new Date(x.signedAt))],
            ['IP address', x.audit?.ip || 'unknown'],
            ['Browser', x.audit?.userAgent || 'unknown'],
            ['Consent', 'Agreed to use electronic records and signatures before signing.'],
          ],
        })),
      ],
      footnote:
        'This certificate was generated automatically when the final signature was applied. The signers consented to sign electronically; ' +
        'electronic signatures are intended to be binding under the U.S. ESIGN Act and UETA. Any change to the document after signing ' +
        'can be detected by comparing the fingerprint above with the document as sent.',
    };
  }

  const outBytes = await stampRecipients(sentBytes, r.fields, signers, certificate);
  if (allDone) {
    await env.FILES.put(`agreements/${r.id}/signed.pdf`, outBytes, PDF_META);
    r.status = 'completed';
    r.completedAt = now.toISOString();
    r.signedHash = await sha256Hex(outBytes);
  } else {
    await env.FILES.put(`agreements/${r.id}/current.pdf`, outBytes, PDF_META);
  }

  r.emailErrors = [];
  if (allDone) {
    r.emailErrors = await emailSignedCopies(env, r, outBytes);
  } else {
    try {
      const mail = signedProgressEmail({ signerName: name, label: r.label, waitingOn: r.recipients.filter((x) => !x.signed).map((x) => x.name) });
      await sendEmail(env, { to: r.owner.email, subject: `${name} signed: ${r.label}`, ...mail });
    } catch (e) {
      r.emailErrors.push(`Could not email you: ${e.message}`);
    }
  }
  await putJson(env, `agr:${r.id}`, r);

  return json({ ok: true, complete: allDone, emailed: r.emailErrors.length === 0, waitingOn: r.recipients.filter((x) => !x.signed).map((x) => x.name) });
}

// Emails the signed PDF to the owner and every recipient. Returns a list of error strings (empty = all good).
async function emailSignedCopies(env, r, bytes) {
  if (!bytes) {
    const obj = await env.FILES.get(`agreements/${r.id}/signed.pdf`);
    if (!obj) return ['Signed file not found.'];
    bytes = await readBytes(obj);
  }
  const attachments = [{ filename: `${safeFilename(r.label)} - Signed.pdf`, content: bytesToBase64(bytes) }];
  const whenText = fmtDateTime(new Date(r.completedAt || Date.now()), tz(env));
  const signerNames = r.recipients.map((x) => x.signedName || x.name);
  const errors = [];
  const targets = [
    { to: r.owner.email, audience: 'owner', who: 'you', subject: `Signed: ${r.label}` },
    ...r.recipients.map((x) => ({ to: x.email, audience: 'recipient', who: x.name, subject: `Your signed copy: ${r.label}` })),
  ];
  for (const t of targets) {
    try {
      const mail = signedCopyEmail({ audience: t.audience, ownerName: r.owner.name, signerNames, label: r.label, whenText });
      await sendEmail(env, { to: t.to, subject: t.subject, attachments, ...mail });
    } catch (e) {
      errors.push(`Could not email ${t.who}: ${e.message}`);
    }
  }
  return errors;
}
