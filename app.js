import { buildPdf, BASE, LH } from './export.js';
import * as pdfjs from '../vendor/pdf.min.mjs';

const V = new URL('../vendor/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const FONTS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };
const CE = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
const SIGFONT = 'italic 150px "Segoe Script","Brush Script MT","Snell Roundhand","Apple Chancery",cursive';

const S = {
  bytes: null, name: '', doc: null, pages: [], ann: [], assets: {}, tool: 'select', scale: 1.25, sel: null,
  grid: false, snap: true, pending: null,
  style: { font: 'Helvetica', size: 14, bold: false, italic: false, color: '#000000', width: 2 },
};
const els = new Map(); // ann id -> {el, txt, cover, svg}
let uid = 0, hist = [], hi = -1, io = null, gp = null, toastT;
const nid = () => 'a' + (++uid);

/* ---------- utilities ---------- */
function toast(m, ms = 3500) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
const toHex = a => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const toPt = (e, p) => { const r = p.el.getBoundingClientRect(); return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale }; };
const pageOf = a => S.pages[a.p - 1];
const isText = a => a.t === 'text' || a.t === 'edit';
const unchanged = a => a.t === 'edit' && a.text === a.orig && a.k0 === styleKey(a);
const styleKey = a => [a.font, a.size, a.bold, a.italic, a.color, a.x, a.y].join('|');
const addAsset = (url, w, h) => { const id = 'i' + (++uid); S.assets[id] = { url, w, h }; return id; };

/* ---------- open PDF ---------- */
async function openFile(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return toast('Please choose a PDF file.');
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let locked = false;
    const task = pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false,
      cMapUrl: V + 'cmaps/', cMapPacked: true, standardFontDataUrl: V + 'standard_fonts/',
    });
    task.onPassword = () => { locked = true; task.destroy(); };
    let doc;
    try { doc = await task.promise; } catch (e) { throw locked ? new Error('Password-protected PDFs are not supported. Remove the password first.') : e; }
    S.doc?.destroy();
    Object.assign(S, { bytes, name: f.name, doc, ann: [], assets: {}, sel: null, pending: null, pages: [] });
    els.clear();
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i), vp = pg.getViewport({ scale: 1, rotation: 0 });
      S.pages.push({ n: i, pg, w: vp.width, h: vp.height, view: pg.view, items: null, rs: null });
    }
    hist = ['[]']; hi = 0;
    document.body.classList.add('has');
    document.body.classList.remove('pend');
    $('#fname').textContent = f.name; $('#fname').title = f.name; $('#done').disabled = false;
    S.scale = clamp(($('#viewer').clientWidth - 60) / S.pages[0].w, 0.5, 2);
    buildPages(); setTool('select'); updHist(); $('#viewer').scrollTop = 0;
  } catch (e) { console.error(e); toast('Could not open this PDF: ' + (e.message || e), 5000); }
}

function buildPages() {
  io?.disconnect();
  const host = $('#pages'); host.innerHTML = '';
  io = new IntersectionObserver(es => es.forEach(en => {
    if (en.isIntersecting) { const p = S.pages[+en.target.dataset.i]; if (p.rs !== S.scale) renderPage(p); }
  }), { root: $('#viewer'), rootMargin: '900px 0px' });
  S.pages.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'page'; el.dataset.i = i;
    el.innerHTML = '<canvas></canvas><div class="covers"></div><div class="hits"></div><div class="layer"></div><svg class="live"></svg><div class="guides"></div>';
    Object.assign(p, { el, canvas: $('canvas', el), covers: $('.covers', el), hits: $('.hits', el), layer: $('.layer', el), live: $('.live', el), gd: $('.guides', el), rs: null });
    el.addEventListener('pointerdown', e => onDown(e, p));
    el.addEventListener('pointermove', e => onHover(e, p));
    el.addEventListener('pointerleave', clearGuides);
    host.appendChild(el);
  });
  layout(); S.ann.forEach(mount);
  S.pages.forEach(p => io.observe(p.el));
  updScroll();
}

function layout() {
  const k = S.scale; $('#zlbl').textContent = Math.round(k * 100) + '%';
  S.pages.forEach(p => {
    const w = p.w * k + 'px', h = p.h * k + 'px';
    Object.assign(p.el.style, { width: w, height: h }); p.el.style.setProperty('--g', 10 * k + 'px');
    Object.assign(p.canvas.style, { width: w, height: h });
    p.el.classList.toggle('grid', S.grid);
    buildHits(p);
  });
  S.ann.forEach(placeEl);
}

async function renderPage(p) {
  if (p.busy) return; p.busy = true;
  const sc = S.scale;
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), vp = p.pg.getViewport({ scale: sc * dpr, rotation: 0 });
    const tmp = document.createElement('canvas'); tmp.width = Math.floor(vp.width); tmp.height = Math.floor(vp.height);
    await p.pg.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
    p.canvas.width = tmp.width; p.canvas.height = tmp.height; p.canvas.getContext('2d').drawImage(tmp, 0, 0);
    if (!p.items) await extractText(p);
    buildHits(p);
  } catch (e) { console.error('render', e); }
  p.rs = sc; p.busy = false;
  if (p.rs !== S.scale) renderPage(p);
}

/* ---------- text extraction (merge runs into editable lines) ---------- */
function pickFont(p, fn, styles) {
  let name = '';
  try { if (p.pg.commonObjs.has(fn)) name = p.pg.commonObjs.get(fn)?.name || ''; } catch { /* font not resolved */ }
  const fam = styles[fn]?.fontFamily || 'sans-serif';
  const mono = /courier|mono|consol/i.test(name) || fam === 'monospace';
  const serif = !/arial|helvet|sans|calibri|verdana|tahoma/i.test(name) && (/times|serif|georgia|garamond|minion|roman|cambria|palatino/i.test(name) || fam === 'serif');
  return { font: mono ? 'Courier' : serif ? 'Times' : 'Helvetica', bold: /bold|black|heavy|semibold/i.test(name), italic: /italic|oblique/i.test(name) };
}
async function extractText(p) {
  const tc = await p.pg.getTextContent(), vp = p.pg.getViewport({ scale: 1, rotation: 0 }), raw = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform), size = Math.hypot(t[2], t[3]);
    if (size < 2 || Math.abs(t[1]) > 0.05 * size) continue; // skip rotated text
    raw.push({ str: it.str, x: t[4], base: t[5], w: it.width, size, fn: it.fontName });
  }
  const out = []; let cur = null;
  for (const r of raw) {
    // wide whitespace-only runs are column gaps (pdf.js emits them as spacer items): split here
    if (!r.str.trim() && r.w >= 0.35 * r.size) { cur = null; continue; }
    if (cur && Math.abs(r.base - cur.base) < 0.6 && Math.abs(r.size - cur.size) < 0.6 && r.fn === cur.fn) {
      const gap = r.x - (cur.x + cur.w);
      if (gap > -1.5 && gap < 0.35 * cur.size) {
        if (gap > 0.1 * cur.size && !/\s$/.test(cur.str) && !/^\s/.test(r.str)) cur.str += ' ';
        cur.str += r.str; cur.w = r.x + r.w - cur.x; continue;
      }
    }
    cur = { ...r }; out.push(cur);
  }
  p.items = out.filter(i => i.str.trim()).map((i, k) => ({ ...i, id: p.n + '-' + k, ...pickFont(p, i.fn, tc.styles) }));
}

function buildHits(p) {
  if (!p.hits) return;
  p.hits.innerHTML = ''; if (!p.items) return;
  const k = S.scale, used = new Set(S.ann.filter(a => a.t === 'edit' && a.p === p.n).map(a => a.origId));
  for (const it of p.items) {
    if (used.has(it.id)) continue;
    const d = document.createElement('div'); d.className = 'hit';
    Object.assign(d.style, { position: 'absolute', left: (it.x - 1) * k + 'px', top: (it.base - BASE * it.size) * k + 'px', width: (it.w + 2) * k + 'px', height: LH * it.size * k + 'px' });
    d.addEventListener('click', e => startEdit(p, it, e));
    p.hits.appendChild(d);
  }
}

function sampleColors(p, it) {
  const c = p.canvas, k = c.width / p.w;
  const x = Math.max(0, Math.floor(it.x * k)), y = Math.max(0, Math.floor((it.base - 0.85 * it.size) * k));
  const w = Math.min(c.width - x, Math.ceil(it.w * k)), h = Math.min(c.height - y, Math.ceil(1.15 * it.size * k));
  if (w <= 0 || h <= 0) return { fg: '#000000', bg: '#ffffff' };
  const d = c.getContext('2d').getImageData(x, y, w, h).data, buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    const b = buckets.get(key) || [0, 0, 0, 0]; b[0]++; b[1] += d[i]; b[2] += d[i + 1]; b[3] += d[i + 2]; buckets.set(key, b);
  }
  let best = null; buckets.forEach(b => { if (!best || b[0] > best[0]) best = b; });
  const bg = [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  let fg = [0, 0, 0], md = -1;
  for (let i = 0; i < d.length; i += 4) {
    const dist = (d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2;
    if (dist > md) { md = dist; fg = [d[i], d[i + 1], d[i + 2]]; }
  }
  if (md < 1500) fg = [0, 0, 0];
  return { fg: toHex(fg), bg: toHex(bg) };
}

/* ---------- annotations: DOM ---------- */
function mount(a) {
  unmount(a);
  const p = pageOf(a), o = {}, el = o.el = document.createElement('div');
  el.className = 'ann ' + a.t; el.dataset.id = a.id;
  if (isText(a)) {
    el.className = 'ann text';
    const g = document.createElement('span'); g.className = 'grip'; g.textContent = '⠿'; g.contentEditable = 'false'; el.appendChild(g);
    g.addEventListener('mousedown', e => e.preventDefault());
    g.addEventListener('pointerdown', e => startDrag(e, a, 'move'));
    const t = o.txt = document.createElement('div'); t.className = 'txt'; t.spellcheck = false; t.contentEditable = CE; t.textContent = a.text; el.appendChild(t);
    if (a.t === 'edit') { o.cover = document.createElement('div'); o.cover.className = 'cover'; p.covers.appendChild(o.cover); }
    wireText(a, o);
  } else {
    if (a.t === 'img') { el.innerHTML = '<img alt=""><span class="rs"></span>'; $('img', el).src = S.assets[a.asset].url; }
    else if (a.t === 'white') el.innerHTML = '<span class="rs"></span>';
    else if (a.t === 'draw') o.svg = el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    el.addEventListener('pointerdown', e => startDrag(e, a, e.target.classList.contains('rs') ? 'resize' : 'move'));
  }
  p.layer.appendChild(el); els.set(a.id, o); placeEl(a);
  if (S.sel === a.id) el.classList.add('sel');
}
function unmount(a) { const o = els.get(a.id); if (!o) return; o.el.remove(); o.cover?.remove(); els.delete(a.id); }

function measure(a) { const o = els.get(a.id); if (o?.txt) { a.w = o.txt.offsetWidth / S.scale; a.h = o.txt.offsetHeight / S.scale; } }
function placeEl(a) {
  const o = els.get(a.id); if (!o) return;
  const k = S.scale, e = o.el;
  e.style.left = a.x * k + 'px'; e.style.top = a.y * k + 'px';
  if (o.txt) {
    const t = o.txt.style;
    t.fontSize = a.size * k + 'px'; t.fontFamily = FONTS[a.font]; t.fontWeight = a.bold ? 700 : 400; t.fontStyle = a.italic ? 'italic' : 'normal'; t.color = a.color;
    measure(a);
    if (o.cover) Object.assign(o.cover.style, { left: a.ox * k + 'px', top: a.oy * k + 'px', width: a.ow * k + 'px', height: a.oh * k + 'px', background: a.bg });
    return;
  }
  e.style.width = a.w * k + 'px'; e.style.height = a.h * k + 'px';
  if (o.svg) {
    const pts = a.pts.map(q => q.join(',')).join(' '), common = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
    o.svg.setAttribute('viewBox', `${a.x} ${a.y} ${a.w} ${a.h}`); o.svg.setAttribute('width', a.w * k); o.svg.setAttribute('height', a.h * k);
    o.svg.innerHTML = `<polyline points="${pts}" ${common} stroke="transparent" stroke-width="${Math.max(a.width, 12 / k)}" pointer-events="stroke"/><polyline points="${pts}" ${common} stroke="${a.color}" stroke-width="${a.width}" pointer-events="none"/>`;
  }
}
function bbox(a) {
  const xs = a.pts.map(q => q[0]), ys = a.pts.map(q => q[1]), h = a.width / 2;
  a.x = Math.min(...xs) - h; a.y = Math.min(...ys) - h; a.w = Math.max(...xs) - Math.min(...xs) + a.width; a.h = Math.max(...ys) - Math.min(...ys) + a.width;
}

function wireText(a, o) {
  const t = o.txt; let dirty = false;
  t.addEventListener('focus', () => { select(a.id); showAlign(a); });
  t.addEventListener('input', () => { a.text = t.innerText.replace(/\n$/, ''); dirty = true; measure(a); showAlign(a); });
  t.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text')); });
  t.addEventListener('keydown', e => { if (e.key === 'Escape') t.blur(); e.stopPropagation(); });
  t.addEventListener('blur', () => {
    clearGuides();
    setTimeout(() => {
      if (!S.ann.includes(a) || $('#props').contains(document.activeElement)) return;
      if ((a.t === 'text' && !a.text.trim()) || unchanged(a)) return removeAnn(a);
      if (dirty) { dirty = false; commit(); }
    }, 0);
  });
}
function focusText(a, cx, cy) {
  const t = els.get(a.id)?.txt; if (!t) return; t.focus();
  try {
    let r;
    if (cx != null) {
      if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(cx, cy); if (c) { r = document.createRange(); r.setStart(c.offsetNode, c.offset); } }
      else if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(cx, cy);
    }
    if (!r || !t.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(t); r.collapse(false); }
    r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch { /* caret placement is best-effort */ }
}

function startEdit(p, it, e) {
  const c = sampleColors(p, it);
  const a = {
    id: nid(), t: 'edit', p: p.n, origId: it.id, ox: it.x - 1, oy: it.base - 0.85 * it.size, ow: it.w + 2, oh: 1.15 * it.size,
    x: it.x, y: it.base - BASE * it.size, text: it.str, orig: it.str, size: it.size, font: it.font, bold: it.bold, italic: it.italic, color: c.fg, bg: c.bg,
  };
  a.k0 = styleKey(a);
  S.ann.push(a); buildHits(p); mount(a); select(a.id); focusText(a, e.clientX, e.clientY);
}
function removeAnn(a) {
  const i = S.ann.indexOf(a); if (i < 0) return;
  S.ann.splice(i, 1); unmount(a); if (S.sel === a.id) { S.sel = null; syncProps(); }
  if (a.t === 'edit') buildHits(pageOf(a));
  commit();
}

/* ---------- selection / history ---------- */
function select(id) { S.sel = id; els.forEach((o, k) => o.el.classList.toggle('sel', k === id)); syncProps(); }
function commit() {
  const j = JSON.stringify(S.ann); if (j === hist[hi]) return;
  hist.length = hi + 1; hist.push(j); if (hist.length > 100) hist.shift(); hi = hist.length - 1; updHist();
}
function restore(j) {
  S.ann.forEach(unmount); S.ann = JSON.parse(j); S.sel = null;
  S.ann.forEach(mount); S.pages.forEach(buildHits); syncProps(); updHist();
}
const undo = () => { if (hi > 0) restore(hist[--hi]); };
const redo = () => { if (hi < hist.length - 1) restore(hist[++hi]); };
function updHist() { $('#undo').disabled = hi <= 0; $('#redo').disabled = hi >= hist.length - 1; }
addEventListener('beforeunload', e => { if (hi > 0) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- alignment & snapping ---------- */
function cands(p, ign) {
  const xs = [0, p.w / 2, p.w, 36, p.w - 36], ys = [0, p.h / 2, p.h, 36, p.h - 36];
  const used = new Set(S.ann.filter(a => a.t === 'edit' && a.p === p.n).map(a => a.origId));
  for (const it of p.items || []) {
    if (used.has(it.id)) continue;
    const top = it.base - BASE * it.size;
    xs.push(it.x, it.x + it.w / 2, it.x + it.w); ys.push(top, it.base, top + LH * it.size);
  }
  for (const a of S.ann) {
    if (a.p !== p.n || a.id === ign || a.w == null) continue;
    xs.push(a.x, a.x + a.w / 2, a.x + a.w); ys.push(a.y, a.y + a.h / 2, a.y + a.h);
    if (isText(a)) ys.push(a.y + BASE * a.size);
  }
  return { xs, ys };
}
/** r = {x,y,w,h,base?} in pt. Returns snap offsets and guide lines. o.resize: only right/bottom edges; o.exact: only report alignments. */
function snapRect(p, r, ign, o = {}) {
  let dx = null, dy = null; const guides = [];
  if (S.snap) {
    const { xs, ys } = cands(p, ign), T = (o.exact ? 0.6 : 6) / S.scale;
    const mx = o.resize ? [r.x + r.w] : [r.x, r.x + r.w / 2, r.x + r.w];
    const my = o.resize ? [r.y + r.h] : [r.y, r.y + r.h / 2, r.y + r.h]; if (r.base != null && !o.resize) my.push(r.base);
    const best = (ms, cs) => { let d = null; for (const m of ms) for (const c of cs) { const v = c - m; if (Math.abs(v) <= T && (d === null || Math.abs(v) < Math.abs(d))) d = v; } return d; };
    dx = best(mx, xs); dy = best(my, ys);
    if (o.exact) dx = dy = 0;
    const eps = o.exact ? T : 0.05, seen = new Set();
    const add = (axis, ms, cs, d) => { for (const m of ms) for (const c of cs) if (Math.abs(m + (d || 0) - c) <= eps && !seen.has(axis + c.toFixed(2))) { seen.add(axis + c.toFixed(2)); guides.push({ a: axis, v: c }); } };
    add('x', mx, xs, dx); add('y', my, ys, dy);
  }
  if (S.grid && !o.exact) {
    if (dx === null) { const v = o.resize ? r.x + r.w : r.x; dx = Math.round(v / 10) * 10 - v; }
    if (dy === null) { const v = o.resize ? r.y + r.h : r.y; dy = Math.round(v / 10) * 10 - v; }
  }
  return { dx: dx || 0, dy: dy || 0, guides };
}
function showGuides(p, g) {
  if (gp && gp !== p) clearGuides();
  gp = p; p.gd.innerHTML = g.map(q => `<div class="gl ${q.a}" style="${q.a === 'x' ? 'left' : 'top'}:${q.v * S.scale}px"></div>`).join('');
}
function clearGuides() { if (gp) { gp.gd.innerHTML = ''; gp = null; } }
function showAlign(a) {
  measure(a); showGuides(pageOf(a), snapRect(pageOf(a), { x: a.x, y: a.y, w: a.w, h: a.h, base: a.y + BASE * a.size }, a.id, { exact: true }).guides);
}

/* ---------- pointer tools ---------- */
function onDown(e, p) {
  if (e.button !== 0) return;
  const t = e.target, pt = toPt(e, p);
  if (S.pending) return placePending(p, pt);
  if (S.tool === 'draw') return startDraw(e, p, pt);
  if (S.tool === 'white') return startWhite(e, p, pt);
  if (t.closest('.ann') || t.classList.contains('hit')) return;
  if (S.tool === 'text') { e.preventDefault(); return createText(p, pt); }
  select(null); document.activeElement?.blur?.();
}
function onHover(e, p) {
  if (e.buttons) return;
  const pt = toPt(e, p);
  if (S.tool === 'text' && !S.pending) {
    const sz = S.style.size; showGuides(p, snapRect(p, { x: pt.x, y: pt.y - BASE * sz, w: 1, h: LH * sz, base: pt.y }, null).guides);
  } else if (S.pending) {
    const d = pendDims(p); showGuides(p, snapRect(p, { x: pt.x - d.w / 2, y: pt.y - d.h / 2, w: d.w, h: d.h }, null).guides);
  }
}
function createText(p, pt) {
  const st = S.style, sz = st.size, r = { x: pt.x, y: pt.y - BASE * sz, w: 40, h: LH * sz, base: pt.y }, sn = snapRect(p, r, null);
  const a = { id: nid(), t: 'text', p: p.n, x: r.x + sn.dx, y: r.y + sn.dy, w: 40, h: LH * sz, text: '', size: sz, font: st.font, bold: st.bold, italic: st.italic, color: st.color };
  S.ann.push(a); mount(a); select(a.id); setTimeout(() => focusText(a), 0);
}

function startDrag(e, a, mode) {
  if (e.button !== 0 || S.tool === 'draw' || S.tool === 'white' || S.pending) return;
  e.preventDefault(); e.stopPropagation(); select(a.id);
  const p = pageOf(a), s0 = toPt(e, p), o = { ...a, pts: a.pts && a.pts.map(q => [...q]) };
  let moved = false;
  const mv = ev => {
    const q = toPt(ev, p); let dx = q.x - s0.x, dy = q.y - s0.y;
    if (!moved && Math.hypot(dx, dy) * S.scale < 3) return; moved = true;
    if (mode === 'move') {
      const r = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h }; if (isText(o)) r.base = r.y + BASE * o.size;
      const sn = snapRect(p, r, a.id); dx += sn.dx; dy += sn.dy; showGuides(p, sn.guides);
      a.x = o.x + dx; a.y = o.y + dy; if (o.pts) a.pts = o.pts.map(v => [v[0] + dx, v[1] + dy]);
    } else {
      let w = Math.max(10, o.w + dx), h = a.t === 'img' ? w * o.h / o.w : Math.max(10, o.h + dy);
      const sn = snapRect(p, { x: o.x, y: o.y, w, h }, a.id, { resize: true });
      w = Math.max(10, w + sn.dx); h = a.t === 'img' ? w * o.h / o.w : Math.max(10, h + sn.dy);
      a.w = w; a.h = h; showGuides(p, sn.guides);
    }
    placeEl(a);
  };
  const up = () => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    clearGuides(); if (moved) commit();
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

function liveInit(p) {
  p.live.setAttribute('width', p.w * S.scale); p.live.setAttribute('height', p.h * S.scale); p.live.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
}
function trackPointer(mv, up) {
  const end = ev => { removeEventListener('pointermove', mv); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); up(ev); };
  addEventListener('pointermove', mv); addEventListener('pointerup', end); addEventListener('pointercancel', end);
}
function startDraw(e, p, pt) {
  e.preventDefault();
  const st = S.style, pts = [[pt.x, pt.y]]; liveInit(p);
  p.live.innerHTML = `<polyline fill="none" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const pl = p.live.firstChild, upd = () => pl.setAttribute('points', pts.map(q => q.join(',')).join(' ')); upd();
  trackPointer(ev => {
    const q = toPt(ev, p), l = pts[pts.length - 1];
    if (Math.hypot(q.x - l[0], q.y - l[1]) * S.scale < 1.5) return; pts.push([q.x, q.y]); upd();
  }, () => {
    p.live.innerHTML = ''; if (pts.length < 2) pts.push([...pts[0]]);
    const a = { id: nid(), t: 'draw', p: p.n, pts, color: st.color, width: st.width }; bbox(a); S.ann.push(a); mount(a); commit();
  });
}
function startWhite(e, p, pt) {
  e.preventDefault(); liveInit(p);
  p.live.innerHTML = '<rect fill="#fff" stroke="#2563eb" stroke-dasharray="4"/>'; const r = p.live.firstChild;
  let box = { x: pt.x, y: pt.y, w: 0, h: 0 };
  trackPointer(ev => {
    const q = toPt(ev, p); box = { x: Math.min(pt.x, q.x), y: Math.min(pt.y, q.y), w: Math.abs(q.x - pt.x), h: Math.abs(q.y - pt.y) };
    const sn = snapRect(p, box, null); showGuides(p, sn.guides);
    Object.entries(box).forEach(([k, v]) => r.setAttribute({ x: 'x', y: 'y', w: 'width', h: 'height' }[k], v));
  }, () => {
    clearGuides(); p.live.innerHTML = '';
    if (box.w > 4 && box.h > 4) { const a = { id: nid(), t: 'white', p: p.n, ...box }; S.ann.push(a); mount(a); commit(); }
  });
}

/* ---------- image & signature placement ---------- */
function pendDims(p) { const as = S.assets[S.pending.asset], w = Math.min(S.pending.w, p.w * 0.6); return { w, h: w * as.h / as.w }; }
function beginPlace(asset, w) {
  S.pending = { asset, w }; document.body.classList.add('pend'); toast('Click on the page to place it — then drag to move, corner to resize.');
}
function placePending(p, pt) {
  const { asset } = S.pending, { w, h } = pendDims(p), r = { x: pt.x - w / 2, y: pt.y - h / 2, w, h }, sn = snapRect(p, r, null);
  const a = { id: nid(), t: 'img', p: p.n, x: r.x + sn.dx, y: r.y + sn.dy, w, h, asset };
  S.pending = null; document.body.classList.remove('pend'); clearGuides(); setTool('select');
  S.ann.push(a); mount(a); select(a.id); commit();
}
async function fileToAsset(file) {
  const bmp = await createImageBitmap(file), m = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * m); c.height = Math.round(bmp.height * m);
  const x = c.getContext('2d'), jpeg = /jpe?g/i.test(file.type);
  if (jpeg) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return addAsset(c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), c.width, c.height);
}

/* signature dialog */
const dlg = $('#sigDlg'), sc = $('#sigCv'), sx = sc.getContext('2d');
let sigTab = 'draw', sigEmpty = true, sigLast = null;
const sigPos = e => { const r = sc.getBoundingClientRect(); return [(e.clientX - r.left) * sc.width / r.width, (e.clientY - r.top) * sc.height / r.height]; };
sc.addEventListener('pointerdown', e => {
  sc.setPointerCapture(e.pointerId); sigEmpty = false; sigLast = sigPos(e);
  Object.assign(sx, { strokeStyle: $('#sigInk').value, lineWidth: 7, lineCap: 'round', lineJoin: 'round' });
  sx.beginPath(); sx.moveTo(...sigLast); sx.lineTo(sigLast[0] + 0.01, sigLast[1]); sx.stroke(); sx.beginPath(); sx.moveTo(...sigLast);
});
sc.addEventListener('pointermove', e => {
  if (!sigLast || !(e.buttons & 1)) return; const [x, y] = sigPos(e), mx = (sigLast[0] + x) / 2, my = (sigLast[1] + y) / 2;
  sx.quadraticCurveTo(sigLast[0], sigLast[1], mx, my); sx.stroke(); sx.beginPath(); sx.moveTo(mx, my); sigLast = [x, y];
});
sc.addEventListener('pointerup', () => { sigLast = null; });
function trim(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 8; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1; o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return o;
}
function typedCanvas() {
  const txt = $('#sigText').value.trim(); if (!txt) return null;
  const c = document.createElement('canvas'); c.width = 1000; c.height = 320; const x = c.getContext('2d');
  x.font = SIGFONT; const w = x.measureText(txt).width; if (w > 940) x.font = SIGFONT.replace('150px', Math.floor(150 * 940 / w) + 'px');
  x.fillStyle = $('#sigInk').value; x.textBaseline = 'middle'; x.fillText(txt, 30, 170); return c;
}
function savedSigs() { try { return JSON.parse(localStorage.getItem('fpe.sigs') || '[]'); } catch { return []; } }
function renderSaved() {
  const box = $('#sigSaved'); box.innerHTML = '';
  savedSigs().forEach(s => { const i = new Image(); i.src = s.u; i.title = 'Use saved signature'; i.onclick = () => useSig(s.u, s.w, s.h, false); box.appendChild(i); });
}
function useSig(url, w, h, save = true) {
  if (save) { try { localStorage.setItem('fpe.sigs', JSON.stringify([{ u: url, w, h }, ...savedSigs()].slice(0, 3))); } catch { /* storage unavailable */ } }
  dlg.close(); beginPlace(addAsset(url, w, h), 150);
}
function openSig() {
  sx.clearRect(0, 0, sc.width, sc.height); sigEmpty = true; $('#sigText').value = ''; $('#sigTypePrev').textContent = ''; renderSaved(); dlg.showModal();
}
$$('.tabs button').forEach(b => b.onclick = () => {
  sigTab = b.dataset.tab; $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#tabDraw').hidden = sigTab !== 'draw'; $('#tabType').hidden = sigTab !== 'type';
});
$('#sigClear').onclick = () => { sx.clearRect(0, 0, sc.width, sc.height); sigEmpty = true; $('#sigText').value = ''; $('#sigTypePrev').textContent = ''; };
$('#sigText').oninput = e => { $('#sigTypePrev').textContent = e.target.value; $('#sigTypePrev').style.color = $('#sigInk').value; };
$('#sigInk').onchange = () => { $('#sigTypePrev').style.color = $('#sigInk').value; };
$('#sigUse').onclick = () => {
  const c = sigTab === 'draw' ? (sigEmpty ? null : sc) : typedCanvas(), t = c && trim(c);
  if (!t) return toast(sigTab === 'draw' ? 'Draw your signature first.' : 'Type your name first.');
  useSig(t.toDataURL('image/png'), t.width, t.height);
};

/* ---------- tools, properties, zoom ---------- */
function setTool(t) {
  S.tool = t; S.pending = null;
  document.body.className = document.body.className.replace(/\b(t-\w+|pend)\b/g, '').trim() + ' t-' + t;
  $$('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  clearGuides();
}
$$('#tools button').forEach(b => b.onclick = () => {
  if (!S.doc) return toast('Open a PDF first.');
  const t = b.dataset.tool;
  if (t === 'sign') openSig(); else if (t === 'image') $('#imgFile').click(); else setTool(t);
});
$('#imgFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const id = await fileToAsset(f); beginPlace(id, 200); } catch (err) { console.error(err); toast('Could not read that image.'); }
};

function syncProps() {
  const a = S.ann.find(x => x.id === S.sel), st = a && isText(a) ? a : S.style, dr = a && a.t === 'draw';
  $('#pFont').value = st.font; $('#pSize').value = Math.round(st.size * 10) / 10;
  $('#pBold').classList.toggle('on', !!st.bold); $('#pItalic').classList.toggle('on', !!st.italic);
  $('#pColor').value = dr ? a.color : st.color; $('#pWidth').value = dr ? a.width : S.style.width; $('#pDel').disabled = !a;
}
let propT;
function setProp(k, v) {
  S.style[k] = v;
  const a = S.ann.find(x => x.id === S.sel);
  if (a) {
    if (isText(a) && k !== 'width') { a[k] = v; placeEl(a); showAlign(a); }
    else if (a.t === 'draw' && (k === 'color' || k === 'width')) { a[k] = v; bbox(a); placeEl(a); }
  }
  clearTimeout(propT); propT = setTimeout(commit, 500);
}
$('#props').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('#pFont').onchange = e => setProp('font', e.target.value);
$('#pSize').oninput = e => { const v = parseFloat(e.target.value); if (v >= 4 && v <= 200) setProp('size', v); };
$('#pBold').onclick = () => { const a = S.ann.find(x => x.id === S.sel); setProp('bold', !(a && isText(a) ? a.bold : S.style.bold)); syncProps(); };
$('#pItalic').onclick = () => { const a = S.ann.find(x => x.id === S.sel); setProp('italic', !(a && isText(a) ? a.italic : S.style.italic)); syncProps(); };
$('#pColor').oninput = e => setProp('color', e.target.value);
$('#pWidth').oninput = e => setProp('width', +e.target.value);
const deleteSel = () => { const a = S.ann.find(x => x.id === S.sel); if (a) removeAnn(a); };
$('#pDel').onclick = deleteSel;

function zoomTo(s) {
  if (!S.doc) return;
  const v = $('#viewer'), r = v.scrollTop / (v.scrollHeight || 1);
  S.scale = clamp(s, 0.4, 4); layout(); v.scrollTop = r * v.scrollHeight;
  S.pages.forEach(p => { p.rs = null; io.unobserve(p.el); io.observe(p.el); });
}
$('#zin').onclick = () => zoomTo(S.scale * 1.15);
$('#zout').onclick = () => zoomTo(S.scale / 1.15);
$('#zlbl').onclick = () => S.doc && zoomTo(($('#viewer').clientWidth - 60) / S.pages[0].w);
$('#snap').onchange = e => { S.snap = e.target.checked; };
$('#grid').onchange = e => { S.grid = e.target.checked; S.pages.forEach(p => p.el.classList.toggle('grid', S.grid)); };
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#viewer').addEventListener('wheel', e => { if (e.ctrlKey && S.doc) { e.preventDefault(); zoomTo(S.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); } }, { passive: false });
function updScroll() {
  if (!S.pages.length) return $('#pgind').textContent = '';
  const v = $('#viewer').getBoundingClientRect(); let cur = 0;
  S.pages.forEach((p, i) => { if (p.el.getBoundingClientRect().top < v.top + v.height / 2) cur = i; });
  $('#pgind').textContent = `Page ${cur + 1} / ${S.pages.length}`;
}
$('#viewer').addEventListener('scroll', updScroll, { passive: true });

/* ---------- keyboard ---------- */
addEventListener('keydown', e => {
  const ae = document.activeElement;
  if (ae && ae.matches('input:not([type=checkbox]):not([type=range]):not([type=color]),select,textarea,[contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (!mod && (k === 'delete' || k === 'backspace') && S.sel) { e.preventDefault(); deleteSel(); }
  else if (k === 'escape') { if (S.pending) { S.pending = null; document.body.classList.remove('pend'); clearGuides(); } else select(null); }
  else if (k.startsWith('arrow') && S.sel) {
    const a = S.ann.find(x => x.id === S.sel); if (!a) return; e.preventDefault();
    const d = e.shiftKey ? 10 : 1, v = { arrowleft: [-d, 0], arrowright: [d, 0], arrowup: [0, -d], arrowdown: [0, d] }[k];
    a.x += v[0]; a.y += v[1]; if (a.pts) a.pts = a.pts.map(q => [q[0] + v[0], q[1] + v[1]]); placeEl(a);
    clearTimeout(propT); propT = setTimeout(commit, 400);
  } else if (!mod && S.doc && { v: 'select', t: 'text', b: 'draw', w: 'white' }[k]) setTool({ v: 'select', t: 'text', b: 'draw', w: 'white' }[k]);
});

/* ---------- export ---------- */
async function done() {
  const btn = $('#done'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    document.activeElement?.blur?.(); await new Promise(r => setTimeout(r, 40));
    const anns = S.ann.filter(a => !unchanged(a));
    const { bytes, replaced } = await buildPdf(S.bytes, anns, S.assets, S.pages.map(p => p.view));
    const chk = await pdfjs.getDocument({ data: bytes.slice() }).promise; // verify output re-opens
    if (chk.numPages !== S.pages.length) throw new Error('Output verification failed');
    chk.destroy();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), a = document.createElement('a');
    a.href = url; a.download = S.name.replace(/\.pdf$/i, '') + '-edited.pdf'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast(replaced ? `Saved. ${replaced} character(s) not supported by the built-in fonts were replaced with "?".` : 'Done! Your edited PDF has been downloaded.', 5500);
    hist = [JSON.stringify(S.ann)]; hi = 0; updHist();
  } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), 6000); }
  finally { btn.disabled = false; btn.textContent = 'Done — Download'; }
}
$('#done').onclick = done;

/* ---------- file open / drag-drop ---------- */
$('#openBtn').onclick = $('#openBtn2').onclick = () => $('#file').click();
$('#file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drag'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });
addEventListener('resize', updScroll);
document.body.classList.add('t-select');
syncProps();
window.__fpe = { S, openFile, done }; // handy for automated tests
