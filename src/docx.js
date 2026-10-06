// Basic .docx -> PDF conversion that runs inside a Worker with no extra libraries.
//
// It keeps text, bold, headings, centered/right alignment, bullet markers and table rows (flattened).
// It does NOT reproduce fonts, images, headers/footers, columns or exact page layout.
// For a contract where layout matters, export to PDF from Word and upload that instead.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { clean } from './pdf.js';

// ---- minimal ZIP reader (central directory + DecompressionStream) ----
async function readZipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .docx file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const lnLen = dv.getUint16(localOff + 26, true);
      const leLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnLen + leLen;
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return td.decode(data);
      if (method !== 8) throw new Error('Unsupported compression in .docx.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return td.decode(await new Response(stream).arrayBuffer());
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('Could not find the document body in that .docx file.');
}

// ---- XML -> simple blocks ----
const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

function parseParagraph(xml) {
  const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] || '';
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(pPr)?.[1] || '';
  const align = /<w:jc\s+w:val="([^"]*)"/.exec(pPr)?.[1] || 'left';
  const isList = /<w:numPr>/.test(pPr);
  const heading = /^(Heading\d|Title)/i.test(style) ? style.toLowerCase() : '';

  const words = []; // {text, bold} | {nl:true} | {pageBreak:true}
  const runRe = /<w:r[ >][\s\S]*?<\/w:r>/g;
  let m;
  while ((m = runRe.exec(xml))) {
    const run = m[0];
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] || '';
    const bm = /<w:b(?:\s+w:val="([^"]*)")?\s*\/>/.exec(rPr);
    const bold = !!bm && !['0', 'false'].includes(bm[1]);
    const partRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>/g;
    let t;
    while ((t = partRe.exec(run))) {
      if (t[1] !== undefined) {
        for (const w of decodeXml(t[1]).split(/\s+/)) if (w) words.push({ text: w, bold });
      } else if (t[0].startsWith('<w:tab')) {
        words.push({ text: '    ', bold, tab: true });
      } else if (/w:type="page"/.test(t[0])) {
        words.push({ pageBreak: true });
      } else {
        words.push({ nl: true });
      }
    }
  }
  return { words, align, isList, heading };
}

function parseBody(docXml) {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(docXml)?.[1] || docXml;
  const blocks = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0].startsWith('<w:tbl>')) {
      for (const row of m[0].match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((tc) =>
          (tc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [])
            .map((p) => parseParagraph(p).words.filter((w) => w.text).map((w) => w.text).join(' '))
            .filter(Boolean).join(' '));
        const text = cells.join('  |  ').trim();
        if (text) blocks.push({ words: text.split(/\s+/).map((t) => ({ text: t, bold: false })), align: 'left', isList: false, heading: '' });
      }
    } else {
      blocks.push(parseParagraph(m[0]));
    }
  }
  return blocks;
}

// ---- layout ----
export async function docxToPdf(bytes) {
  const xml = await readZipEntry(bytes, 'word/document.xml');
  const blocks = parseBody(xml);
  if (!blocks.some((b) => b.words.some((w) => w.text && !w.tab))) {
    throw new Error('No readable text was found in that Word document.');
  }

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 72, maxW = W - 2 * M;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };

  for (const block of blocks) {
    const size = block.heading.startsWith('title') ? 20 : block.heading === 'heading1' ? 16 : block.heading === 'heading2' ? 13 : block.heading ? 12 : 11;
    const lead = size * 1.3;
    const forceBold = !!block.heading;
    const spaceW = regular.widthOfTextAtSize(' ', size);

    // Build lines of positioned words.
    const lines = [];
    let cur = [];
    let curW = 0;
    const flush = () => { lines.push({ items: cur, width: curW }); cur = []; curW = 0; };
    const items = block.isList ? [{ text: '•', bold: false }, ...block.words] : block.words;

    if (items.length === 0) { // empty paragraph = blank line
      if (y - lead < M) newPage();
      y -= lead * 0.8;
      continue;
    }
    for (const w of items) {
      if (w.pageBreak) { flush(); lines.push({ pageBreak: true }); continue; }
      if (w.nl) { flush(); continue; }
      const font = w.bold || forceBold ? boldFont : regular;
      let text = clean(w.text);
      let tw = font.widthOfTextAtSize(text, size);
      while (tw > maxW && text.length > 1) { // break over-long tokens
        let cut = text.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(text.slice(0, cut), size) > maxW) cut--;
        if (cur.length) flush();
        cur.push({ text: text.slice(0, cut), font }); curW = font.widthOfTextAtSize(text.slice(0, cut), size); flush();
        text = text.slice(cut); tw = font.widthOfTextAtSize(text, size);
      }
      const add = (cur.length ? spaceW : 0) + tw;
      if (curW + add > maxW && cur.length) flush();
      curW += (cur.length ? spaceW : 0) + tw;
      cur.push({ text, font });
    }
    if (cur.length) flush();

    for (const line of lines) {
      if (line.pageBreak) { newPage(); continue; }
      if (y - size < M) newPage();
      let x = M;
      if (block.align === 'center') x = M + (maxW - line.width) / 2;
      else if (block.align === 'right') x = M + maxW - line.width;
      for (const it of line.items) {
        page.drawText(it.text, { x, y: y - size, size, font: it.font, color: rgb(0, 0, 0) });
        x += it.font.widthOfTextAtSize(it.text, size) + spaceW;
      }
      y -= lead;
    }
    y -= block.heading ? 6 : 4;
  }
  return doc.save();
}
