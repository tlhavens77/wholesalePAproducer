import { SigPad } from '/sigpad.js';
import { renderPdf } from '/pdfview.js';

// Box sizes in PDF points — keep in sync with FIELD_TYPES in src/pdf.js.
const TYPES = {
  sender_signature: { w: 190, h: 56, label: 'My signature', role: 'sender' },
  sender_date: { w: 90, h: 18, label: 'My date (auto)', role: 'sender' },
  recipient_signature: { w: 190, h: 56, label: 'Recipient signs here', role: 'recipient' },
  recipient_date: { w: 90, h: 18, label: 'Recipient date (auto)', role: 'recipient' },
  recipient_name: { w: 170, h: 18, label: 'Recipient name (auto)', role: 'recipient' },
};

const $ = (id) => document.getElementById(id);
let settings = { name: '', email: '', signature: '' };
let draft = null; // { draftId, pageCount, converted }
let fields = [];
let pages = [];
let tool = null;
let lastLink = '';

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401 && path !== '/api/login') { showView('v-login'); throw new Error('Please log in.'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function showView(id) {
  for (const v of ['v-login', 'v-dash', 'v-new']) $(v).hidden = v !== id;
  $('nav').hidden = id === 'v-login';
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

// ---------------------------------------------------------------- login
$('f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('pw').value }) });
    $('pw').value = '';
    await start();
  } catch (err) { $('login-err').textContent = err.message; }
});

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showView('v-login');
});

// ---------------------------------------------------------------- settings dialog
const pad = new SigPad($('s-pad'));
let typedMode = false;

function setMode(typed) {
  typedMode = typed;
  $('s-tab-draw').classList.toggle('on', !typed);
  $('s-tab-type').classList.toggle('on', typed);
  $('s-typed').hidden = !typed;
  pad.resize();
  if (typed) pad.typed($('s-typed').value);
}
$('s-tab-draw').addEventListener('click', () => setMode(false));
$('s-tab-type').addEventListener('click', () => { setMode(true); $('s-typed').focus(); });
$('s-typed').addEventListener('input', () => pad.typed($('s-typed').value));
$('s-clear').addEventListener('click', () => { pad.clear(); $('s-typed').value = ''; });
$('s-cancel').addEventListener('click', () => $('dlg-settings').close());

function openSettings() {
  $('s-name').value = settings.name;
  $('s-email').value = settings.email;
  $('s-err').textContent = '';
  $('s-current').hidden = !settings.signature;
  if (settings.signature) $('s-prev').src = settings.signature;
  $('s-typed').value = '';
  $('dlg-settings').showModal();
  setMode(false);
  pad.clear();
}
$('btn-settings').addEventListener('click', openSettings);

$('s-save').addEventListener('click', async () => {
  $('s-err').textContent = '';
  const sig = pad.toDataURL(); // null means "keep the saved signature"
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('s-name').value, email: $('s-email').value, signature: sig }),
    });
    await loadSettings();
    $('dlg-settings').close();
    toast('Saved.');
  } catch (err) { $('s-err').textContent = err.message; }
});

async function loadSettings() {
  settings = await api('/api/settings');
}

// ---------------------------------------------------------------- dashboard
async function loadDash() {
  const { agreements } = await api('/api/agreements');
  const body = $('dash-body');
  body.textContent = '';
  $('dash-empty').hidden = agreements.length > 0;
  $('dash-table').hidden = agreements.length === 0;

  for (const a of agreements) {
    const statusText = a.status === 'completed' ? `Signed ${fmt(a.completedAt)}`
      : a.status === 'void' ? 'Voided'
      : a.viewedAt ? 'Opened, not signed yet' : 'Waiting for signature';
    const base = `/api/agreements/${a.id}/pdf`;
    const actions = [];
    if (a.status === 'completed') {
      actions.push(h('a', { class: 'btn primary', href: `${base}?kind=signed&download=1` }, 'Download signed PDF'));
      actions.push(h('a', { class: 'btn', href: `${base}?kind=signed`, target: '_blank', rel: 'noopener' }, 'View'));
      actions.push(h('button', { onclick: () => act(a.id, 'resend') }, 'Re-send copies'));
    } else if (a.status === 'sent') {
      actions.push(h('a', { class: 'btn', href: `${base}?kind=sent`, target: '_blank', rel: 'noopener' }, 'View'));
      actions.push(h('button', { onclick: () => act(a.id, 'resend') }, 'Send reminder'));
      actions.push(h('button', { onclick: async () => { await navigator.clipboard.writeText(a.link); toast('Link copied.'); } }, 'Copy link'));
      actions.push(h('button', { class: 'danger', onclick: () => { if (confirm('Void this agreement? The link will stop working.')) act(a.id, 'void'); } }, 'Void'));
    } else {
      actions.push(h('a', { class: 'btn', href: `${base}?kind=original`, target: '_blank', rel: 'noopener' }, 'Original'));
    }
    body.append(h('tr', {},
      h('td', {}, h('strong', {}, a.label), h('div', { class: 'muted' }, `Sent ${fmt(a.createdAt)}`)),
      h('td', {}, a.recipient.name, h('div', { class: 'muted' }, a.recipient.email)),
      h('td', {}, h('span', { class: `badge ${a.status}` }, statusText),
        ...a.emailErrors.map((m) => h('div', { class: 'error' }, m))),
      h('td', {}, h('div', { class: 'actions' }, actions))));
  }
}

async function act(id, what) {
  try {
    const r = await api(`/api/agreements/${id}/${what}`, { method: 'POST' });
    toast(r.message || 'Done.');
    await loadDash();
  } catch (err) { toast(err.message); }
}

$('btn-dash').addEventListener('click', async () => { showView('v-dash'); await loadDash().catch((e) => toast(e.message)); });

// ---------------------------------------------------------------- new agreement: step 1
$('btn-new').addEventListener('click', () => {
  if (!settings.signature || !settings.name) { toast('Set up your name and signature first.'); openSettings(); return; }
  $('f-new').reset();
  $('oemail').value = settings.email;
  $('new-err').textContent = '';
  step(1);
  showView('v-new');
});

function step(n) {
  $('step1').hidden = n !== 1;
  $('step2').hidden = n !== 2;
  $('step3').hidden = n !== 3;
  window.scrollTo(0, 0);
}

$('f-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('new-err').textContent = '';
  const btn = $('btn-prepare');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('file', $('file').files[0]);
    fd.append('label', $('label').value);
    fd.append('recipientName', $('rname').value);
    fd.append('recipientEmail', $('remail').value);
    fd.append('ownerEmail', $('oemail').value);
    fd.append('message', $('msg').value);
    fd.append('appendSignaturePage', $('addpage').checked ? 'true' : 'false');
    draft = await api('/api/upload-prepare', { method: 'POST', body: fd });
    fields = draft.fields || [];
    tool = null;
    $('convnote').hidden = !draft.converted;
    step(2);
    buildToolbar();
    await renderPlacement();
  } catch (err) {
    $('new-err').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Next: place signature boxes';
  }
});

// ---------------------------------------------------------------- step 2: placement
function buildToolbar() {
  const bar = $('toolbar');
  bar.textContent = '';
  for (const [type, t] of Object.entries(TYPES)) {
    bar.append(h('button', {
      class: `tool-${t.role}`, 'data-type': type,
      onclick: () => { tool = tool === type ? null : type; markTool(); },
    }, t.label));
  }
}

function markTool() {
  for (const b of $('toolbar').children) b.classList.toggle('on', b.dataset.type === tool);
  for (const p of pages) p.wrap.style.cursor = tool ? 'crosshair' : '';
}

async function renderPlacement() {
  $('pages').textContent = 'Loading document…';
  try {
    pages = await renderPdf($('pages'), `/api/draft/${draft.draftId}/pdf`);
  } catch (err) {
    $('pages').textContent = '';
    $('send-err').textContent = err.message;
    return;
  }
  for (const p of pages) {
    p.wrap.addEventListener('click', (ev) => {
      if (!tool || ev.target.closest('.field')) return;
      const r = p.wrap.getBoundingClientRect();
      const t = TYPES[tool];
      const w = t.w / p.ptW;
      const hh = t.h / p.ptH;
      const x = Math.min(Math.max((ev.clientX - r.left) / r.width - w / 2, 0), 1 - w);
      const y = Math.min(Math.max((ev.clientY - r.top) / r.height - hh / 2, 0), 1 - hh);
      fields.push({ id: crypto.randomUUID(), type: tool, page: p.index, x, y, w, h: hh });
      tool = null;
      markTool();
      drawBoxes(p);
      summarize();
    });
    drawBoxes(p);
  }
  summarize();
}

function drawBoxes(p) {
  p.wrap.querySelectorAll('.field').forEach((el) => el.remove());
  for (const f of fields.filter((q) => q.page === p.index)) {
    const t = TYPES[f.type];
    const box = h('div', { class: `field ${t.role}` }, t.label);
    box.style.cssText = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
    if (f.type === 'sender_signature' && settings.signature) {
      box.style.backgroundImage = `url(${settings.signature})`;
      box.textContent = '';
    }
    const x = h('button', { class: 'x', title: 'Remove' }, '×');
    x.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fields = fields.filter((q) => q.id !== f.id);
      drawBoxes(p);
      summarize();
    });
    box.append(x);

    box.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      box.setPointerCapture(ev.pointerId);
      const r = p.wrap.getBoundingClientRect();
      const sx = ev.clientX, sy = ev.clientY, ox = f.x, oy = f.y;
      const move = (e2) => {
        f.x = Math.min(Math.max(ox + (e2.clientX - sx) / r.width, 0), 1 - f.w);
        f.y = Math.min(Math.max(oy + (e2.clientY - sy) / r.height, 0), 1 - f.h);
        box.style.left = `${f.x * 100}%`;
        box.style.top = `${f.y * 100}%`;
      };
      const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
    });
    p.wrap.append(box);
  }
}

function summarize() {
  const n = (type) => fields.filter((f) => f.type === type).length;
  const parts = [];
  parts.push(`${n('recipient_signature')} recipient signature box${n('recipient_signature') === 1 ? '' : 'es'}`);
  parts.push(`${n('sender_signature')} of your signature`);
  $('sendsummary').textContent = `Placed: ${parts.join(', ')}. Will be emailed to ${$('remail').value}.`;
}

$('btn-back').addEventListener('click', () => step(1));

$('btn-send').addEventListener('click', async () => {
  $('send-err').textContent = '';
  if (!fields.some((f) => f.type === 'recipient_signature')) { $('send-err').textContent = 'Place at least one “Recipient signs here” box.'; return; }
  if (!fields.some((f) => f.type === 'sender_signature') && !confirm('You haven’t placed your own signature. Send anyway?')) return;
  const btn = $('btn-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await api('/api/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, fields }),
    });
    lastLink = r.link;
    $('sent-msg').textContent = `${$('rname').value} was emailed a signing link at ${$('remail').value}.`;
    step(3);
  } catch (err) {
    $('send-err').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to recipient';
  }
});

$('btn-copylink').addEventListener('click', async () => { await navigator.clipboard.writeText(lastLink); toast('Link copied.'); });
$('btn-done').addEventListener('click', async () => { showView('v-dash'); await loadDash().catch((e) => toast(e.message)); });

// ---------------------------------------------------------------- start
async function start() {
  const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
  if (!me.authed) { showView('v-login'); return; }
  await loadSettings();
  showView('v-dash');
  await loadDash().catch((e) => toast(e.message));
  if (!settings.signature || !settings.name) openSettings();
}

start();
