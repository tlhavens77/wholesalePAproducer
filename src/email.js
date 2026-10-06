// Email via Resend (https://resend.com). Needs RESEND_API_KEY secret and a verified sending domain.
// Cloudflare's own Worker email binding can only send to pre-verified addresses, so it can't
// deliver to arbitrary recipients — that's why a transactional email API is used here.

import { escapeHtml } from './util.js';

export async function sendEmail(env, { to, subject, html, text, attachments, replyTo }) {
  if (env.DEV_NO_EMAIL === 'true') {
    console.log('[DEV_NO_EMAIL] would send:', { to, subject, attachments: (attachments || []).map((a) => a.filename) });
    return { skipped: true };
  }
  if (!env.RESEND_API_KEY) throw new Error('Email is not configured: set the RESEND_API_KEY secret.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${env.APP_NAME || 'Contract Signer'} <${env.FROM_EMAIL}>`,
      to: [to],
      subject,
      html,
      text,
      reply_to: replyTo,
      attachments,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Email provider error (${res.status}): ${body.slice(0, 300)}`);
  }
  return { ok: true };
}

function wrap(inner) {
  return `<div style="font-family:Calibri,Carlito,Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">${inner}</div>`;
}

export function signRequestEmail({ ownerName, label, link, message }) {
  const note = message ? `<p style="padding:12px;background:#f4f4f4;border-radius:6px;white-space:pre-wrap">${escapeHtml(message)}</p>` : '';
  const html = wrap(`
    <p><strong>${escapeHtml(ownerName)}</strong> has sent you a document to review and sign:</p>
    <p style="font-size:17px"><strong>${escapeHtml(label)}</strong></p>
    ${note}
    <p><a href="${link}" style="display:inline-block;background:#1b5e8c;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">Review &amp; sign</a></p>
    <p style="color:#666;font-size:13px">If the button doesn't work, copy this link into your browser:<br>${link}</p>
    <p style="color:#666;font-size:13px">This link is personal to you. Please don't forward it.</p>`);
  const text = `${ownerName} has sent you a document to sign: ${label}\n\n${message ? message + '\n\n' : ''}Review and sign: ${link}\n`;
  return { html, text };
}

export function signedCopyEmail({ audience, ownerName, recipientName, label, whenText }) {
  const who = audience === 'owner' ? `${escapeHtml(recipientName)} has signed` : `Thank you for signing`;
  const html = wrap(`
    <p>${who} <strong>${escapeHtml(label)}</strong>.</p>
    <p>Signed ${escapeHtml(whenText)}. The fully signed PDF, including a certificate of completion, is attached.</p>
    <p style="color:#666;font-size:13px">${audience === 'owner' ? '' : `Sent on behalf of ${escapeHtml(ownerName)}.`}</p>`);
  const text = `${audience === 'owner' ? recipientName + ' has signed' : 'Thank you for signing'} ${label}.\nSigned ${whenText}. The signed PDF is attached.\n`;
  return { html, text };
}
