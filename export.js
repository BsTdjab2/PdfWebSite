// Pure export logic (no DOM). Coordinates in annotations are PDF points, origin top-left of the page view.
export const BASE = 0.94; // baseline offset from top of a text box, in em
export const LH = 1.2;    // line height, in em

const hex = h => {
  const n = parseInt((h || '#000000').replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
};
const FONT_NAMES = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

/**
 * @param {Uint8Array} bytes original PDF
 * @param {Array} anns annotations
 * @param {Object} assets {id:{url,w,h}} image data URLs
 * @param {Array} views per-page pdf.js `view` ([x0,y0,x1,y1])
 * @returns {{bytes:Uint8Array, replaced:number}}
 */
export async function buildPdf(bytes, anns, assets, views) {
  const { PDFDocument, StandardFonts, rgb, LineCapStyle } = globalThis.PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const fonts = {}, imgs = {};
  let replaced = 0;

  const font = async (f, b, i) => {
    const idx = (b ? 1 : 0) + (i ? 2 : 0), k = f + idx;
    return fonts[k] || (fonts[k] = await doc.embedFont(StandardFonts[(FONT_NAMES[f] || FONT_NAMES.Helvetica)[idx]]));
  };
  const image = async id => {
    if (imgs[id]) return imgs[id];
    const url = assets[id].url;
    const buf = await (await fetch(url)).arrayBuffer();
    return (imgs[id] = /^data:image\/jpe?g/i.test(url) ? await doc.embedJpg(buf) : await doc.embedPng(buf));
  };
  const clean = (f, s) => [...s].map(ch => {
    try { f.widthOfTextAtSize(ch, 1); return ch; } catch { replaced++; return ch === '\t' ? '  ' : '?'; }
  }).join('');

  const geo = a => {
    const v = views[a.p - 1] || [0, 0, 0, 0];
    return { X: x => v[0] + x, Y: y => v[3] - y };
  };

  // Pass 1: covers behind edited text (original text is painted over first)
  for (const a of anns) {
    if (a.t !== 'edit') continue;
    const { X, Y } = geo(a), [r, g, b] = hex(a.bg);
    pages[a.p - 1].drawRectangle({ x: X(a.ox), y: Y(a.oy + a.oh), width: a.ow, height: a.oh, color: rgb(r, g, b), borderWidth: 0 });
  }
  // Pass 2: everything else in z-order
  for (const a of anns) {
    const pg = pages[a.p - 1]; if (!pg) continue;
    const { X, Y } = geo(a);
    if (a.t === 'white') {
      pg.drawRectangle({ x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h, color: rgb(1, 1, 1), borderWidth: 0 });
    } else if (a.t === 'text' || a.t === 'edit') {
      if (!a.text || !a.text.trim()) continue;
      const f = await font(a.font, a.bold, a.italic), [r, g, b] = hex(a.color);
      a.text.split('\n').forEach((line, i) => {
        if (!line.trim()) return;
        pg.drawText(clean(f, line), { x: X(a.x), y: Y(a.y + (BASE + i * LH) * a.size), size: a.size, font: f, color: rgb(r, g, b) });
      });
    } else if (a.t === 'img') {
      pg.drawImage(await image(a.asset), { x: X(a.x), y: Y(a.y + a.h), width: a.w, height: a.h });
    } else if (a.t === 'draw') {
      const [r, g, b] = hex(a.color), col = rgb(r, g, b), P = a.pts;
      if (P.length < 2) continue;
      if (P.length === 2 && P[0][0] === P[1][0] && P[0][1] === P[1][1]) {
        pg.drawCircle({ x: X(P[0][0]), y: Y(P[0][1]), size: a.width / 2, color: col, borderWidth: 0 });
        continue;
      }
      for (let i = 1; i < P.length; i++) {
        pg.drawLine({ start: { x: X(P[i - 1][0]), y: Y(P[i - 1][1]) }, end: { x: X(P[i][0]), y: Y(P[i][1]) }, thickness: a.width, color: col, lineCap: LineCapStyle.Round });
      }
    }
  }
  return { bytes: await doc.save(), replaced };
}
