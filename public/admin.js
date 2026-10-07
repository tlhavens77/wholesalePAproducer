import { padWidget } from '/sigpad.js';
import { renderPdf } from '/pdfview.js';
import { detectFields, wordsFromItems } from '/autoplace.js';

// Box sizes in PDF points — keep in sync with FIELD_TYPES in src/pdf.js.
const BASE = {
  signature: { w: 190, h: 56, label: 'Signature', short: 'Sign' },
  date: { w: 90, h: 18, label: 'Date (auto)', short: 'Date' },
  name: { w: 170, h: 18, label: 'Printed name (auto)', short: 'Name' },
  initials: { w: 44, h: 18, label: 'Initials (every page)', short: 'Init' },
};

const $ = (id) => document.getElementById(id);
let settings = { name: '', email: '', signature: '', initials: '' };
let draft = null; // { draftId, pageCount, converted, recipients }
let parties = []; // [{ role, signer, label, cls }]
let fields = [];
let pages = [];
let tool = null; // { role, signer, base }

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
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}

function showView(id) {
  for (const v of ['v-login', 'v-dash', 'v-new']) $(v).hidden = v !== id;
  $('nav').hidden = id === 'v-login';
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const firstName = (n) => String(n).trim().split(/\s+/)[0];
const initialsOf = (n) => String(n).trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3);
const copy = async (text) => { await navigator.clipboard.writeText(text); toast('Link copied.'); };

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
const sigW = padWidget($('s-sig'), { height: 150, typedDefault: () => $('s-name').value });
const iniW = padWidget($('s-ini'), { height: 90, typedDefault: () => initialsOf($('s-name').value) });

function openSettings() {
  $('s-name').value = settings.name;
  $('s-email').value = settings.email;
  $('s-err').textContent = '';
  $('s-current').hidden = !settings.signature;
  if (settings.signature) $('s-prev').src = settings.signature;
  $('s-icurrent').hidden = !settings.initials;
  if (settings.initials) $('s-iprev').src = settings.initials;
  $('dlg-settings').showModal();
  sigW.reset();
  iniW.reset();
}
$('btn-settings').addEventListener('click', openSettings);
$('s-cancel').addEventListener('click', () => $('dlg-settings').close());

$('s-save').addEventListener('click', async () => {
  $('s-err').textContent = '';
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      // null = keep what is already saved
      body: JSON.stringify({ name: $('s-name').value, email: $('s-email').value, signature: sigW.toDataURL(), initials: iniW.toDataURL() }),
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
    const signedCount = a.recipients.filter((x) => x.signed).length;
    const statusText = a.status === 'completed' ? `Fully signed ${fmt(a.completedAt)}`
      : a.status === 'void' ? 'Voided'
      : signedCount ? `${signedCount} of ${a.recipients.length} signed` : 'Waiting for signatures';
    const base = `/api/agreements/${a.id}/pdf`;
    const actions = [];
    if (a.status === 'completed') {
      actions.push(h('a', { class: 'btn primary', href: `${base}?kind=signed&download=1` }, 'Download signed PDF'));
      actions.push(h('a', { class: 'btn', href: `${base}?kind=signed`, target: '_blank', rel: 'noopener' }, 'View'));
      actions.push(h('button', { onclick: () => act(a.id, 'resend') }, 'Re-send copies'));
    } else if (a.status === 'sent') {
      actions.push(h('a', { class: 'btn', href: `${base}?kind=latest`, target: '_blank', rel: 'noopener' }, 'View'));
      actions.push(h('button', { onclick: () => act(a.id, 'resend') }, 'Send reminder'));
      for (const x of a.recipients.filter((r) => r.link)) {
        actions.push(h('button', { onclick: () => copy(x.link) }, a.recipients.length > 1 ? `Copy link: ${firstName(x.name)}` : 'Copy link'));
      }
      actions.push(h('button', { class: 'danger', onclick: () => { if (confirm('Void this agreement? The links will stop working.')) act(a.id, 'void'); } }, 'Void'));
    } else {
      actions.push(h('a', { class: 'btn', href: `${base}?kind=original`, target: '_blank', rel: 'noopener' }, 'Original'));
    }
    body.append(h('tr', {},
      h('td', {}, h('strong', {}, a.label), h('div', { class: 'muted' }, `Sent ${fmt(a.createdAt)}`)),
      h('td', {}, a.recipients.map((x) => h('div', {}, `${x.name} `, h('span', { class: x.signed ? 'ok' : 'muted' }, x.signed ? '✓ signed' : '· waiting'), h('div', { class: 'muted' }, x.email)))),
      h('td', {}, h('span', { class: `badge ${a.status}` }, statusText), ...a.emailErrors.map((m) => h('div', { class: 'error' }, m))),
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
  $('r2box').hidden = true;
  $('docx-hint').hidden = true;
  $('oemail').value = settings.email;
  $('new-err').textContent = '';
  step(1);
  showView('v-new');
});

$('two').addEventListener('change', () => {
  $('r2box').hidden = !$('two').checked;
  $('rname2').required = $('remail2').required = $('two').checked;
});
$('file').addEventListener('change', () => { $('docx-hint').hidden = !/\.docx$/i.test($('file').files[0]?.name || ''); });

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
    if ($('two').checked) {
      fd.append('recipient2Name', $('rname2').value);
      fd.append('recipient2Email', $('remail2').value);
    }
    fd.append('ownerEmail', $('oemail').value);
    fd.append('message', $('msg').value);
    fd.append('appendSignaturePage', $('addpage').checked ? 'true' : 'false');
    draft = await api('/api/upload-prepare', { method: 'POST', body: fd });
    fields = draft.fields || [];
    parties = [
      { role: 'sender', signer: 0, label: 'Me', cls: 'sender' },
      ...draft.recipients.map((r, i) => ({ role: 'recipient', signer: i, label: r.name, cls: `recipient s${i}` })),
    ];
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
const typeOf = (party, base) => `${party.role}_${base}`;
const sameTool = (a, b) => a && b && a.role === b.role && a.signer === b.signer && a.base === b.base;

function buildToolbar() {
  const bar = $('toolbar');
  bar.textContent = '';
  for (const party of parties) {
    const row = h('div', { class: 'tgroup' }, h('strong', { class: `who ${party.cls}` }, party.role === 'sender' ? 'Me' : party.label));
    for (const base of ['signature', 'date', 'name', 'initials']) {
      const t = { role: party.role, signer: party.signer, base };
      row.append(h('button', {
        class: `tool ${party.cls}`, 'data-key': `${party.role}-${party.signer}-${base}`,
        onclick: () => {
          if (base === 'initials' && party.role === 'sender' && !settings.initials) { toast('Add your initials under My signature first.'); openSettings(); return; }
          tool = sameTool(tool, t) ? null : t;
          markTool();
        },
      }, BASE[base].label));
    }
    row.append(h('button', {
      class: 'tool-clear', title: 'Remove this person’s initials from every page',
      onclick: () => { fields = fields.filter((f) => !(f.type === typeOf(party, 'initials') && (f.signer || 0) === party.signer)); pages.forEach(drawBoxes); summarize(); },
    }, 'Clear initials'));
    bar.append(row);
  }
  bar.append(h('div', { class: 'tgroup' },
    h('button', { class: 'primary', onclick: () => autoPlace(true) }, 'Auto-place all'),
    h('span', { class: 'muted' }, 'Finds the initial lines, signature, name and date lines and fills them in.')));
}

function markTool() {
  for (const b of $('toolbar').querySelectorAll('.tool')) {
    b.classList.toggle('on', !!tool && b.dataset.key === `${tool.role}-${tool.signer}-${tool.base}`);
  }
  for (const p of pages) p.wrap.style.cursor = tool ? 'crosshair' : '';
}

async function renderPlacement() {
  $('pages').textContent = 'Loading document…';
  $('send-err').textContent = '';
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
      const t = BASE[tool.base];
      const w = t.w / p.ptW;
      const hh = t.h / p.ptH;
      const x = Math.min(Math.max((ev.clientX - r.left) / r.width - w / 2, 0), 1 - w);
      const y = Math.min(Math.max((ev.clientY - r.top) / r.height - hh / 2, 0), 1 - hh);
      const type = `${tool.role}_${tool.base}`;
      const targets = tool.base === 'initials' ? pages : [p]; // initials go on every page, same spot
      let added = 0;
      for (const q of targets) {
        if (fields.some((f) => f.type === type && f.page === q.index && (f.signer || 0) === tool.signer)) continue;
        const nf = { id: crypto.randomUUID(), type, page: q.index, x, y, w: t.w / q.ptW, h: t.h / q.ptH };
        if (tool.role === 'recipient') nf.signer = tool.signer;
        fields.push(nf);
        added++;
      }
      if (tool.base === 'initials') toast(added ? `Initials placed on ${added} page${added === 1 ? '' : 's'}. Drag any one to fine-tune it.` : 'Those initials are already on every page. Use “Clear initials” to start over.');
      tool = null;
      markTool();
      pages.forEach(drawBoxes);
      summarize();
    });
    drawBoxes(p);
  }
  summarize();
  await autoPlace(false);
}

// Finds the initial lines and signature blocks from the document text and places every box.
// replace=false (first open): only fills in what is not placed yet. replace=true: starts over.
async function autoPlace(replace) {
  try {
    const data = [];
    for (const p of pages) {
      const tc = await p.pdfPage.getTextContent();
      data.push({ ptW: p.ptW, ptH: p.ptH, words: wordsFromItems(tc.items, p.ptH) });
    }
    const { fields: found, summary } = detectFields(data, draft.recipients.length);
    if (replace) fields = [];
    const have = (f) => fields.some((q) => q.type === f.type && (q.signer || 0) === (f.signer || 0) && (f.type.endsWith('_initials') ? q.page === f.page : true));
    let added = 0;
    for (const f of found) {
      if (have(f)) continue;
      fields.push({ id: crypto.randomUUID(), ...f });
      added++;
    }
    pages.forEach(drawBoxes);
    summarize();
    if (!added) {
      toast(found.length ? 'Everything is already placed.' : 'Could not find the initial lines or signature blocks. Place the boxes by hand.');
    } else {
      const missing = [];
      if (!summary.buyerBlock) missing.push('your signature block');
      if (summary.sellerBlocks < draft.recipients.length) missing.push('a seller signature block');
      if (!summary.initialPages) missing.push('the initial lines');
      toast(`Placed ${added} boxes automatically.${missing.length ? ` Could not find ${missing.join(' or ')} — add by hand.` : ' Check them, then send.'}`);
    }
  } catch (err) {
    toast('Automatic placement failed — place the boxes by hand.');
  }
}

function drawBoxes(p) {
  p.wrap.querySelectorAll('.field').forEach((el) => el.remove());
  for (const f of fields.filter((q) => q.page === p.index)) {
    const [role, base] = f.type.split('_');
    const party = parties.find((x) => x.role === role && (role === 'sender' || x.signer === (f.signer || 0)));
    const box = h('div', { class: `field ${party ? party.cls : role}`, title: `${party ? party.label : ''}: ${BASE[base].label}` }, BASE[base].short);
    box.style.cssText = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
    if (role === 'sender' && base === 'signature' && settings.signature) { box.style.backgroundImage = `url(${settings.signature})`; box.textContent = ''; }
    if (role === 'sender' && base === 'initials' && settings.initials) { box.style.backgroundImage = `url(${settings.initials})`; box.textContent = ''; }
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
  const count = (type, signer = null) => fields.filter((f) => f.type === type && (signer === null || (f.signer || 0) === signer)).length;
  const parts = [`you: ${count('sender_signature')} signature, ${count('sender_initials')} initials`];
  draft.recipients.forEach((r, i) => parts.push(`${firstName(r.name)}: ${count('recipient_signature', i)} signature, ${count('recipient_initials', i)} initials`));
  $('sendsummary').textContent = `Placed — ${parts.join('; ')}. A signing link will be emailed to ${draft.recipients.map((r) => r.email).join(' and ')}.`;
}

$('btn-back').addEventListener('click', () => step(1));

$('btn-send').addEventListener('click', async () => {
  $('send-err').textContent = '';
  for (let i = 0; i < draft.recipients.length; i++) {
    if (!fields.some((f) => f.type === 'recipient_signature' && (f.signer || 0) === i)) {
      $('send-err').textContent = `Place at least one signature box for ${draft.recipients[i].name}.`;
      return;
    }
  }
  if (!fields.some((f) => f.type === 'sender_signature') && !confirm('You haven’t placed your own signature. Send anyway?')) return;
  const btn = $('btn-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await api('/api/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, fields }),
    });
    $('sent-msg').textContent = r.emailErrors.length
      ? 'The agreement was created, but not every email went out. Share the links below yourself, or use “Send reminder” on the dashboard.'
      : `Signing links were emailed to ${r.links.map((l) => l.email).join(' and ')}.`;
    const box = $('sent-links');
    box.textContent = '';
    for (const e of r.emailErrors) box.append(h('p', { class: 'error' }, e));
    for (const l of r.links) box.append(h('p', {}, h('button', { onclick: () => copy(l.link) }, `Copy link for ${l.name}`)));
    step(3);
  } catch (err) {
    $('send-err').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to recipients';
  }
});

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
