// Signature pad: draw with mouse/finger/pen, or type a name in a handwriting-style font.
// toDataURL() returns a tightly cropped transparent PNG (or null if empty).

const INK = '#111827';
const SCRIPT_FONT = '"Segoe Script","Brush Script MT","Snell Roundhand","Apple Chancery","Lucida Handwriting","Bradley Hand",cursive';

export class SigPad {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dirty = false;
    this.drawing = false;
    this.last = null;
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    const up = () => { this.drawing = false; this.last = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', up);
  }

  resize() {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const w = this.c.clientWidth || 400;
    const h = this.c.clientHeight || 140;
    this.c.width = Math.round(w * ratio);
    this.c.height = Math.round(h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.lineWidth = 2.6;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = INK;
    this.dirty = false;
  }

  pos(e) {
    const r = this.c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    e.preventDefault();
    this.c.setPointerCapture(e.pointerId);
    this.drawing = true;
    this.last = this.pos(e);
    // a dot for a simple tap
    this.ctx.beginPath();
    this.ctx.arc(this.last.x, this.last.y, 1.2, 0, Math.PI * 2);
    this.ctx.fillStyle = INK;
    this.ctx.fill();
    this.dirty = true;
  }

  move(e) {
    if (!this.drawing) return;
    const p = this.pos(e);
    this.ctx.beginPath();
    this.ctx.moveTo(this.last.x, this.last.y);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
    this.last = p;
    this.dirty = true;
  }

  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.c.width, this.c.height);
    this.ctx.restore();
    this.dirty = false;
  }

  isEmpty() {
    return !this.dirty;
  }

  typed(text) {
    this.clear();
    const t = (text || '').trim();
    if (!t) return;
    const w = this.c.clientWidth;
    const h = this.c.clientHeight;
    let size = Math.min(72, h * 0.6);
    this.ctx.fillStyle = INK;
    this.ctx.textBaseline = 'middle';
    this.ctx.font = `${size}px ${SCRIPT_FONT}`;
    while (this.ctx.measureText(t).width > w - 24 && size > 18) {
      size -= 2;
      this.ctx.font = `${size}px ${SCRIPT_FONT}`;
    }
    this.ctx.fillText(t, 12, h / 2);
    this.dirty = true;
  }

  toDataURL() {
    if (!this.dirty) return null;
    const { width: W, height: H } = this.c;
    const data = this.ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const scale = Math.min(1, 700 / cw);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale));
    out.height = Math.max(1, Math.round(ch * scale));
    out.getContext('2d').drawImage(this.c, minX, minY, cw, ch, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
}
