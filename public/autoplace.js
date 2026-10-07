// Finds the signing lines of a purchase agreement from its text and returns ready-made boxes.
// Pure functions, no DOM: unit-testable in Node.
//
// It looks for the wording this contract uses:
//   "Buyer initials: ____   Seller initials: ____"        (page footers)
//   "Seller signature:" (x2, side by side) / "Buyer ... signature:"
//   with "Signature", "Printed name: ____" and "Date: ____" under each.
// Buyer = you (sender); the left Seller block is recipient 1, the right one recipient 2.

const BOX = { sigH: 30, sigW: 160, nameH: 16, dateW: 90, iniH: 16, iniMinW: 26 };

// pdf.js text items -> words with positions in points, top-left origin.
export function wordsFromItems(items, ptH) {
  const words = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const len = it.str.length;
    const x = it.transform[4];
    const size = Math.abs(it.transform[3]) || it.height || 10;
    const top = ptH - it.transform[5] - size * 0.8;
    const bottom = ptH - it.transform[5] + size * 0.2;
    const w = it.width || size * 0.5 * len;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      words.push({ str: m[0], x0: x + (w * m.index) / len, x1: x + (w * (m.index + m[0].length)) / len, top, bottom });
    }
  }
  return words;
}

function lines(words) {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const out = [];
  for (const w of sorted) {
    const l = out.find((q) => Math.abs(q.top - w.top) < 3);
    if (l) l.words.push(w);
    else out.push({ top: w.top, words: [w] });
  }
  for (const l of out) l.words.sort((a, b) => a.x0 - b.x0);
  return out;
}

const isBlank = (s) => /^[_‐-―\-.]{3,}$/.test(s) && /_/.test(s);

// The blank (underscore run) right after word `w` on its line, if any.
function blankAfter(line, w) {
  const next = line.words.find((q) => q.x0 >= w.x1 - 1 && isBlank(q.str) && q.x0 - w.x1 < 12);
  return next || null;
}

export function detectFields(pages, recipientCount = 1) {
  const fields = [];
  const found = { buyer: false, seller: [false, false] };
  const add = (page, type, signer, x, top, w, h, ptW, ptH) => {
    const x0 = Math.max(0, Math.min(x, ptW - w));
    const y0 = Math.max(0, Math.min(top, ptH - h));
    const f = { type, page, x: x0 / ptW, y: y0 / ptH, w: w / ptW, h: h / ptH };
    if (type.startsWith('recipient_')) f.signer = signer;
    fields.push(f);
  };

  pages.forEach((pg, pi) => {
    const { ptW, ptH } = pg;
    const ls = lines(pg.words);

    // ---- initials: "Buyer initials: ___ Seller initials: ___"
    for (const l of ls) {
      l.words.forEach((w, i) => {
        if (!/^initials:?$/i.test(w.str)) return;
        const who = (l.words[i - 1]?.str || '').toLowerCase();
        if (who !== 'buyer' && who !== 'seller') return;
        const blank = blankAfter(l, w);
        const x = blank ? blank.x0 - 1 : w.x1 + 4;
        const bw = Math.max(blank ? blank.x1 - blank.x0 + 2 : 0, BOX.iniMinW);
        const top = w.bottom - BOX.iniH + 1;
        if (who === 'buyer') {
          add(pi, 'sender_initials', 0, x, top, bw, BOX.iniH, ptW, ptH);
        } else {
          for (let s = 0; s < Math.min(2, recipientCount); s++) add(pi, 'recipient_initials', s, x + s * (bw + 2), top, bw, BOX.iniH, ptW, ptH);
        }
      });
    }

    // ---- signature blocks
    const labels = [];
    for (const l of ls) {
      l.words.forEach((w, i) => {
        if (!/^signature:$/i.test(w.str)) return;
        let j = i;
        while (j > 0 && !/^(buyer|seller)$/i.test(l.words[j].str) && !/^signature:$/i.test(l.words[j - 1].str)) j--;
        const who = l.words[j].str.toLowerCase();
        if (who !== 'buyer' && who !== 'seller') return;
        labels.push({ role: who, x0: l.words[j].x0, top: l.top, bottom: Math.max(...l.words.map((q) => q.bottom)) });
      });
    }
    labels.sort((a, b) => a.top - b.top || a.x0 - b.x0);
    // columns: from this label's x to the next label's x on the same row
    labels.forEach((lb) => {
      const sameRow = labels.filter((q) => Math.abs(q.top - lb.top) < 3 && q.x0 > lb.x0 + 5);
      lb.right = sameRow.length ? Math.min(...sameRow.map((q) => q.x0)) - 4 : ptW;
      lb.left = lb.x0 - 6;
      // the next block below in an overlapping column bounds this one
      const below = labels.filter((q) => q.top > lb.top + 5 && q.x0 < lb.right && q.x0 + 5 > lb.left - 300);
      lb.limit = below.length ? Math.min(...below.map((q) => q.top)) : ptH;
    });
    let sellerIdx = 0;
    for (const lb of labels) {
      const inCol = (w) => w.x0 >= lb.left && w.x0 < lb.right;
      const under = ls.filter((l) => l.top > lb.bottom - 2 && l.top < lb.limit);
      let signer = 0;
      if (lb.role === 'seller') { signer = sellerIdx++; if (signer >= recipientCount || signer > 1) continue; }

      // the printed "Signature" caption marks where the line is
      let capTop = null;
      for (const l of under) {
        const cap = l.words.find((w) => inCol(w) && /^signature$/i.test(w.str));
        if (cap) { capTop = cap.top; break; }
      }
      const sigBottom = capTop != null ? capTop - 1 : lb.bottom + 40;
      const sigH = Math.min(BOX.sigH, Math.max(sigBottom - lb.bottom + 8, 20));
      const type = (b) => (lb.role === 'buyer' ? `sender_${b}` : `recipient_${b}`);
      add(pi, type('signature'), signer, lb.x0, sigBottom - sigH, BOX.sigW, sigH, ptW, ptH);

      for (const [base, labelRe, maxW] of [['name', /^name:$/i, 170], ['date', /^date:$/i, BOX.dateW]]) {
        for (const l of under) {
          const idx = l.words.findIndex((w) => inCol(w) && labelRe.test(w.str));
          if (idx < 0) continue;
          const w = l.words[idx];
          const blank = blankAfter(l, w);
          const x = w.x1 + 3;
          const bw = Math.min(blank ? blank.x1 - x : maxW, maxW);
          add(pi, type(base), signer, x, w.bottom - BOX.nameH + 2, bw, BOX.nameH, ptW, ptH);
          break;
        }
      }
      if (lb.role === 'buyer') found.buyer = true; else found.seller[signer] = true;
    }
  });

  const initials = fields.filter((f) => f.type === 'sender_initials').length;
  return { fields, summary: { buyerBlock: found.buyer, sellerBlocks: found.seller.filter(Boolean).length, initialPages: initials } };
}
