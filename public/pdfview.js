// Renders every page of a PDF into a container using pdf.js (loaded from cdnjs by the page).
// Returns one entry per page so callers can overlay boxes using percentage positions.

export async function renderPdf(container, url, maxWidth = 860) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('The PDF viewer could not load. Check your connection and reload.');
  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = 'Could not load the document.';
    try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  const pdf = await lib.getDocument({ data: await res.arrayBuffer() }).promise;

  container.textContent = '';
  const width = Math.min(container.clientWidth || maxWidth, maxWidth);
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const vp = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'pagewrap';
    wrap.style.width = `${vp.width}px`;
    wrap.style.height = `${vp.height}px`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * ratio);
    canvas.height = Math.floor(vp.height * ratio);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const tag = document.createElement('div');
    tag.className = 'pageno';
    tag.textContent = `Page ${i} of ${pdf.numPages}`;
    container.appendChild(tag);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;

    pages.push({ index: i - 1, wrap, ptW: base.width, ptH: base.height });
  }
  return pages;
}
