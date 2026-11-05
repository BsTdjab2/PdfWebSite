# FreePDF Editor

Free, private, in-browser PDF editor (pdfFiller-style). No backend, no uploads, no account.

## Run
Needs a static web server (ES modules + pdf.js worker don't run from `file://`):

```
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
```
Deploy by copying the folder to any static host (Netlify, GitHub Pages, S3, nginx). All libraries are bundled in `vendor/`, so it works offline.

## Features
- **Edit existing text**: Edit tool (V) → click any text, type. Original is covered with the sampled background colour, new text is drawn with matching size/colour/font family.
- **Text (T)**, **Brush (B)**, **Sign** (draw or type; last 3 saved locally), **Image** (PNG/JPG/WebP…), **Erase/whiteout (W)**.
- **Alignment**: magenta smart guides + snapping to text baselines/edges/centres, other objects, page edges/centre and 36 pt margins. Guides show while dragging, resizing, typing and hovering with the Text tool. Optional 10 pt grid. Toggle in the top bar.
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z), arrow-key nudging (Shift = 10 pt), Delete, zoom (buttons or Ctrl+wheel), drag-and-drop open.
- **Done — Download**: bakes all edits into the original PDF with pdf-lib, re-opens the result to verify it, then downloads `<name>-edited.pdf`.

## Layout
```
index.html  css/style.css
js/app.js      UI, tools, snapping, history
js/export.js   DOM-free PDF export (pdf-lib)
vendor/        pdf.js 4.10, pdf-lib 1.17 (+ cmaps, standard fonts)
```

## Known limitations
- Edited text uses the PDF standard fonts (Helvetica/Times/Courier, WinAnsi). Characters outside that set (e.g. Arabic, CJK, emoji) are replaced with `?` and you get a notice. To support them, embed a Unicode TTF with `@pdf-lib/fontkit` in `export.js`.
- Editing covers the original text with a rectangle; the original text remains in the file underneath (still searchable/copyable). Don't use it for secure redaction.
- Password-protected PDFs aren't supported. Rotated text isn't editable; pages with a `/Rotate` entry are edited in their unrotated frame.
- Scanned PDFs have no text layer: use Text/Whiteout on them.
