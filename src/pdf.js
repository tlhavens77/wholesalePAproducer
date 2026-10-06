// PDF work: stamping signature/date fields, adding a signature page, adding the certificate page.
// Uses pdf-lib with the built-in Helvetica fonts (no font files to bundle).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Default field sizes in PDF points. The placement UI uses the same numbers.
// Recipient fields carry a `signer` number (0 = first recipient, 1 = second recipient).
export const FIELD_TYPES = {
  sender_signature: { w: 190, h: 56 },
  sender_date: { w: 90, h: 18 },
  sender_name: { w: 170, h: 18 },
  sender_initials: { w: 44, h: 18 },
  recipient_signature: { w: 190, h: 56 },
  recipient_date: { w: 90, h: 18 },
  recipient_name: { w: 170, h: 18 },
  recipient_initials: { w: 44, h: 18 },
};

const INK = rgb(0.07, 0.07, 0.1);
const GREY = rgb(0.4, 0.4, 0.4);

// Standard PDF fonts only cover WinAnsi. Anything else would make pdf-lib throw, so swap it for "?".
const CP1252_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)));
export function clean(s) {
  return Array.from(String(s ?? ''), (ch) => {
    const cp = ch.codePointAt(0);
    if (cp === 0x2610) return '[ ]'; // empty check box
    if (cp === 0x2611 || cp === 0x2612) return '[X]'; // checked check box
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(cp)) return ch;
    if (cp === 9) return '    ';
    if (cp === 10 || cp === 13) return ' ';
    return '?';
  }).join('');
}

export async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes);
  } catch (e) {
    throw new Error('That PDF could not be read. It may be password-protected or damaged.');
  }
}

async function fonts(doc) {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}

export function wrapText(text, font, size, maxW) {
  const lines = [];
  for (const para of [clean(text)]) {
    let cur = '';
    for (const word of para.split(' ')) {
      // Break very long tokens (hashes, URLs) by character.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const trial = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) <= maxW) cur = trial;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

// Draw the fields of one party onto the document.
// role is 'sender' or 'recipient'; for recipients, `signer` picks which recipient's fields to fill.
async function applyFields(doc, f, fields, role, d, signer = null) {
  const pages = doc.getPages();
  const sigImg = d.signaturePng ? await doc.embedPng(d.signaturePng) : null;
  const iniImg = d.initialsPng ? await doc.embedPng(d.initialsPng) : null;
  for (const field of fields) {
    if (!field.type.startsWith(`${role}_`)) continue;
    if (signer !== null && (field.signer || 0) !== signer) continue;
    const page = pages[field.page];
    if (!page) continue;
    const { width: W, height: H } = page.getSize();
    const x = field.x * W;
    const w = field.w * W;
    const h = field.h * H;
    const y = H - field.y * H - h; // convert top-left fractions to PDF bottom-left points

    if (field.type.endsWith('_signature') && sigImg) {
      const nameSize = 8;
      const nameH = nameSize + 3;
      const imgBoxH = Math.max(h - nameH, 10);
      const scale = Math.min(w / sigImg.width, imgBoxH / sigImg.height);
      const iw = sigImg.width * scale;
      const ih = sigImg.height * scale;
      page.drawImage(sigImg, { x, y: y + nameH + (imgBoxH - ih) / 2, width: iw, height: ih });
      if (d.name) page.drawText(clean(d.name), { x, y: y + 1, size: nameSize, font: f.regular, color: GREY, maxWidth: w });
    } else if (field.type.endsWith('_initials') && iniImg) {
      const scale = Math.min(w / iniImg.width, h / iniImg.height);
      const iw = iniImg.width * scale;
      const ih = iniImg.height * scale;
      page.drawImage(iniImg, { x: x + (w - iw) / 2, y: y + (h - ih) / 2, width: iw, height: ih });
    } else if (field.type.endsWith('_date') && d.dateText) {
      page.drawText(clean(d.dateText), { x, y: y + (h - 10) / 2 + 1, size: 10, font: f.regular, color: INK });
    } else if (field.type.endsWith('_name') && d.name) {
      page.drawText(clean(d.name), { x, y: y + (h - 11) / 2 + 1, size: 11, font: f.regular, color: INK, maxWidth: w });
    }
  }
}

// Stamp the sender's signature, printed name and date. Returns the "as sent" PDF.
export async function stampSender(pdfBytes, fields, d) {
  const doc = await loadPdf(pdfBytes);
  const f = await fonts(doc);
  await applyFields(doc, f, fields, 'sender', d);
  return doc.save();
}

// Stamp every recipient who has signed so far onto the "as sent" PDF.
// `signers` = [{ index, signaturePng, initialsPng, name, dateText }]. Pass a certificate to append it
// (done only once everybody has signed).
export async function stampRecipients(sentBytes, fields, signers, certificate) {
  const doc = await loadPdf(sentBytes);
  const f = await fonts(doc);
  for (const s of signers) await applyFields(doc, f, fields, 'recipient', s, s.index);
  if (certificate) drawCertificate(doc, f, certificate);
  return doc.save();
}

function drawCertificate(doc, f, cert) {
  const W = 612;
  const H = 792;
  const M = 54;
  const labelW = 150;
  let page = doc.addPage([W, H]);
  let y = H - M;

  page.drawText('Certificate of Completion', { x: M, y: y - 18, size: 20, font: f.bold, color: INK });
  y -= 34;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: GREY });
  y -= 22;

  const need = (space) => {
    if (y - space < M + 20) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };

  for (const section of cert.sections) {
    need(40);
    page.drawText(clean(section.heading), { x: M, y: y - 12, size: 12, font: f.bold, color: INK });
    y -= 26;
    for (const [label, value] of section.rows) {
      const lines = wrapText(value, f.regular, 10, W - 2 * M - labelW);
      need(lines.length * 13 + 4);
      page.drawText(clean(label), { x: M, y: y - 10, size: 9, font: f.bold, color: GREY });
      lines.forEach((line, i) => page.drawText(line, { x: M + labelW, y: y - 10 - i * 13, size: 10, font: f.regular, color: INK }));
      y -= lines.length * 13 + 5;
    }
    y -= 10;
  }

  need(60);
  for (const line of wrapText(cert.footnote, f.regular, 8.5, W - 2 * M)) {
    page.drawText(line, { x: M, y: y - 9, size: 8.5, font: f.regular, color: GREY });
    y -= 11.5;
  }
}

// Append a standard signature page and return default field positions for it.
// `recipients` = [{ name }, ...] (one or two). Each party gets signature, date and printed-name boxes.
export async function appendSignaturePage(pdfBytes, { ownerName, recipients, label }) {
  const doc = await loadPdf(pdfBytes);
  const f = await fonts(doc);
  const first = doc.getPage(0).getSize();
  const W = first.width;
  const H = first.height;
  const page = doc.addPage([W, H]);
  const pageIndex = doc.getPageCount() - 1;
  const M = 72;

  page.drawText('Signature Page', { x: M, y: H - 100, size: 20, font: f.bold, color: INK });
  wrapText(`Agreement: ${label}`, f.regular, 11, W - 2 * M).forEach((line, i) =>
    page.drawText(line, { x: M, y: H - 124 - i * 14, size: 11, font: f.regular, color: GREY }));

  const fields = [];
  const fr = (x, yTop, w, h, type, signer) => ({
    id: crypto.randomUUID(), type, page: pageIndex, x: x / W, y: yTop / H, w: w / W, h: h / H, ...(signer === undefined ? {} : { signer }),
  });
  const block = (top, party, role, signer) => {
    page.drawText(clean(party), { x: M, y: H - top + 22, size: 12, font: f.bold, color: INK });
    page.drawLine({ start: { x: M, y: H - (top + 58) }, end: { x: M + 190, y: H - (top + 58) }, thickness: 0.8, color: INK });
    page.drawText('Signature', { x: M, y: H - (top + 70), size: 8, font: f.regular, color: GREY });
    page.drawLine({ start: { x: 340, y: H - (top + 58) }, end: { x: 430, y: H - (top + 58) }, thickness: 0.8, color: INK });
    page.drawText('Date', { x: 340, y: H - (top + 70), size: 8, font: f.regular, color: GREY });
    page.drawLine({ start: { x: M, y: H - (top + 98) }, end: { x: M + 190, y: H - (top + 98) }, thickness: 0.8, color: INK });
    page.drawText('Printed name', { x: M, y: H - (top + 110), size: 8, font: f.regular, color: GREY });
    fields.push(fr(M, top, 190, 56, `${role}_signature`, signer));
    fields.push(fr(340, top + 38, 90, 18, `${role}_date`, signer));
    fields.push(fr(M, top + 80, 170, 18, `${role}_name`, signer));
  };

  block(190, ownerName, 'sender');
  recipients.forEach((r, i) => block(190 + 170 * (i + 1), r.name, 'recipient', i));

  return { bytes: await doc.save(), fields };
}
