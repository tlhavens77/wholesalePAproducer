import { padWidget } from '/sigpad.js';
import { renderPdf } from '/pdfview.js';

const $ = (id) => document.getElementById(id);
const token = location.pathname.split('/').pop();
const api = (path, opts = {}) => fetch(`/api/sign/${token}${path}`, opts);

const MARKERS = {
  recipient_signature: 'Sign here',
  recipient_date: 'Date (automatic)',
  recipient_name: 'Name (automatic)',
  recipient_initials: 'Init.',
};
const joinNames = (n) => (n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
const initialsOf = (n) => String(n).trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3);

function view(id) {
  for (const v of ['v-msg', 'v-sign', 'v-done']) $(v).hidden = v !== id;
}

function message(title, body) {
  $('msg-title').textContent = title;
  $('msg-body').textContent = body;
  view('v-msg');
}

async function showDone({ title, text, download }) {
  $('done-title').textContent = title;
  $('done-msg').textContent = text;
  $('dl').hidden = !download;
  if (download) $('dl').href = `/api/sign/${token}/download`;
  view('v-done');
  try { await renderPdf($('done-pages'), `/api/sign/${token}/pdf`); } catch (e) { /* the download still works */ }
}

async function init() {
  const res = await api('');
  if (res.status === 404) return message('Link not valid', 'This signing link is not valid. Please check the link in your email.');
  const info = await res.json();

  $('title').textContent = info.label;
  if (info.status === 'void') return message('No longer available', 'The sender has cancelled this agreement. Please contact them if you think this is a mistake.');
  if (info.status === 'completed') {
    return showDone({ title: 'Fully signed', text: 'Everyone has signed this document. You can download the completed copy below.', download: true });
  }
  if (info.signed) {
    return showDone({
      title: 'Thank you — you have signed',
      text: info.waitingOn.length
        ? `Still waiting on ${joinNames(info.waitingOn)}. When everyone has signed, the completed PDF will be emailed to you.`
        : 'Your signature has been recorded.',
      download: false,
    });
  }

  view('v-sign');
  $('intro').textContent = `${info.ownerName} asked you to review and sign this document. Scroll through it, then sign at the bottom.`;
  $('name').value = info.signerName;

  try {
    const pages = await renderPdf($('pages'), `/api/sign/${token}/pdf`);
    for (const f of info.fields) {
      const p = pages[f.page];
      if (!p) continue;
      const box = document.createElement('div');
      box.className = `field recipient sign-here${f.signer === 1 ? ' s1' : ''}`;
      box.style.cssText = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
      box.textContent = MARKERS[f.type] || '';
      p.wrap.append(box);
    }
  } catch (err) {
    $('pages').textContent = err.message;
  }

  const sig = padWidget($('sig'), { height: 150, typedDefault: () => $('name').value });
  const ini = padWidget($('ini'), { height: 90, typedDefault: () => initialsOf($('name').value) });
  $('ini-wrap').hidden = !info.needsInitials;
  window.addEventListener('resize', () => { if (sig.isEmpty()) sig.resize(); });
  $('jump').addEventListener('click', () => $('signbox').scrollIntoView({ behavior: 'smooth' }));

  $('submit').addEventListener('click', async () => {
    $('err').textContent = '';
    const name = $('name').value.trim();
    const signature = sig.toDataURL();
    const initials = info.needsInitials ? ini.toDataURL() : null;
    if (name.length < 2) return ($('err').textContent = 'Please type your full name.');
    if (!signature) return ($('err').textContent = 'Please draw or type your signature.');
    if (info.needsInitials && !initials) return ($('err').textContent = 'Please draw or type your initials.');
    if (!$('consent').checked) return ($('err').textContent = 'Please tick the box to agree to sign electronically.');

    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Signing…';
    try {
      const r = await api('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, signature, initials, consent: true }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      $('jump').hidden = true;
      window.scrollTo(0, 0);
      if (data.complete) {
        await showDone({
          title: 'Signed — thank you',
          text: data.emailed ? 'Everyone has now signed. The completed copy was emailed to you and to the sender.' : 'Everyone has now signed. We could not email the copy, so please download it below.',
          download: true,
        });
      } else {
        await showDone({
          title: 'Thank you — you have signed',
          text: `Your signature has been recorded. Still waiting on ${joinNames(data.waitingOn)}. The completed PDF will be emailed to you when everyone has signed.`,
          download: false,
        });
      }
    } catch (err) {
      $('err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Sign and submit';
    }
  });
}

init().catch((e) => message('Something went wrong', e.message));
