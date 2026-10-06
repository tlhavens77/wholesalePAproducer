import { SigPad } from '/sigpad.js';
import { renderPdf } from '/pdfview.js';

const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/').pop();
const api = (path, opts = {}) => fetch(`/api/sign/${token}${path}`, opts);

const MARKERS = {
  recipient_signature: 'Sign here',
  recipient_date: 'Date (automatic)',
  recipient_name: 'Your name (automatic)',
};

function view(id) {
  for (const v of ['v-msg', 'v-sign', 'v-done']) $(v).hidden = v !== id;
}

function message(title, body) {
  $('msg-title').textContent = title;
  $('msg-body').textContent = body;
  view('v-msg');
}

async function showDone(msg) {
  $('done-msg').textContent = msg;
  $('dl').href = `/api/sign/${token}/download`;
  view('v-done');
  try { await renderPdf($('done-pages'), `/api/sign/${token}/pdf`); } catch (e) { /* download still works */ }
}

async function init() {
  const res = await api('');
  if (res.status === 404) return message('Link not valid', 'This signing link is not valid. Please check the link in your email.');
  const info = await res.json();

  $('title').textContent = info.label;
  if (info.status === 'void') return message('No longer available', 'The sender has cancelled this agreement. Please contact them if you think this is a mistake.');
  if (info.status === 'completed') return showDone('This document has already been signed. You can download the signed copy below.');

  view('v-sign');
  $('intro').textContent = `${info.ownerName} asked you to review and sign this document. Scroll through it, then sign at the bottom.`;
  $('name').value = info.recipientName;

  try {
    const pages = await renderPdf($('pages'), `/api/sign/${token}/pdf`);
    for (const f of info.fields) {
      const p = pages[f.page];
      if (!p) continue;
      const box = document.createElement('div');
      box.className = 'field recipient sign-here';
      box.style.cssText = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
      box.textContent = MARKERS[f.type] || '';
      p.wrap.append(box);
    }
  } catch (err) {
    $('pages').textContent = err.message;
  }
  setupPad();
}

function setupPad() {
  const pad = new SigPad($('pad'));
  let typed = false;
  const mode = (t) => {
    typed = t;
    $('tab-draw').classList.toggle('on', !t);
    $('tab-type').classList.toggle('on', t);
    $('typed').hidden = !t;
    pad.resize();
    if (t) pad.typed($('typed').value || $('name').value);
  };
  $('tab-draw').addEventListener('click', () => mode(false));
  $('tab-type').addEventListener('click', () => { mode(true); if (!$('typed').value) $('typed').value = $('name').value; pad.typed($('typed').value); });
  $('typed').addEventListener('input', () => pad.typed($('typed').value));
  $('clear').addEventListener('click', () => { pad.clear(); $('typed').value = ''; });
  $('jump').addEventListener('click', () => $('signbox').scrollIntoView({ behavior: 'smooth' }));
  window.addEventListener('resize', () => { if (pad.isEmpty()) pad.resize(); });

  $('submit').addEventListener('click', async () => {
    $('err').textContent = '';
    const name = $('name').value.trim();
    const signature = pad.toDataURL();
    if (name.length < 2) return ($('err').textContent = 'Please type your full name.');
    if (!signature) return ($('err').textContent = typed ? 'Please type your name for the signature.' : 'Please draw your signature.');
    if (!$('consent').checked) return ($('err').textContent = 'Please tick the box to agree to sign electronically.');

    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Signing…';
    try {
      const res = await api('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, signature, consent: true }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      $('jump').hidden = true;
      window.scrollTo(0, 0);
      await showDone(data.emailed
        ? 'Your signature has been recorded. A signed copy was emailed to you and to the sender.'
        : 'Your signature has been recorded. We could not email the copy, so please download it below.');
    } catch (err) {
      $('err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Sign and submit';
    }
  });
}

init().catch((e) => message('Something went wrong', e.message));
