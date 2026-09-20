---
name: paper-pdf-rendering
description: >
  Hard-won contracts and traps for the paper plugin's PDF pipeline and viewer
  (packages/plugin-paper/ui/*, pdfjs-dist integration, text selection, anchors).
  Invoke when touching PDF rendering, page display, text selection/划词, zoom,
  text-layer alignment, PDF assets/worker, or when a PDF rendering or selection
  bug is reported ("重影", "doubled text", "selection wrong", "blurry pdf",
  "text misaligned", "PDF 不显示").
---

# Paper PDF rendering: contracts and traps

Everything below was learned the hard way. Check this list **before** changing
anything in `packages/plugin-paper/ui/`, and use the verification recipes
instead of eyeballing.

## 1. Non-negotiable contracts

### 1.1 pdf.js v5 TextLayer CSS contract
pdf.js v5 sizes glyphs with
`font-size: calc(var(--text-scale-factor) * var(--font-height))` where
`--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size))`,
and transforms with
`rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))`.

- Set `--total-scale-factor` (= the active scale) **directly on the page wrapper**
  (`.pdf-page`) and on the offscreen layer before it is inserted.
- **Never** rely on pdf.js's own `.pdfViewer .page` rule or its `--user-unit`
  indirection: we do not use that wrapper, so the calc chain silently resolves to
  nothing and spans fall back to the app's inherited font size (≈14.4px instead of
  ≈9.6px) → overlapping glyphs and garbled selection.

### 1.2 The text layer must stay transparent **while selected**
`packages/client/src/index.css` has a global
`::selection { color: var(--selection-color, #1a1410); }`.
That overrides `color: transparent` for the text layer the moment the user
selects text, painting the layer's **browser-font** glyphs on top of the page's
**embedded-font** glyphs → doubled/garbled text. Users select text constantly
(划词提问), so it looks permanent.

Keep this rule in `PdfPanel.css`:
```css
.pdf-page-text-layer ::selection {
  color: transparent;
  -webkit-text-fill-color: transparent;
  background: var(--selection-bg, rgba(122, 90, 56, 0.25));
}
```
Generalise: any global state-dependent rule (`::selection`, `:hover`, `:focus`,
`[data-theme]`) can reveal a layer we assume is invisible.

### 1.3 HiDPI (Retina)
```ts
const outputScale = Math.max(1, window.devicePixelRatio || 1);
canvas.width  = Math.max(1, Math.floor(viewport.width  * outputScale));
canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
canvas.style.width  = `${Math.floor(viewport.width)}px`;   // CSS px
canvas.style.height = `${Math.floor(viewport.height)}px`;
page.render({ canvas, viewport, ...(outputScale !== 1
  ? { transform: [outputScale, 0, 0, outputScale, 0, 0] } : {}) });
```
Without this, the bitmap is CSS-sized and the compositor upscales it → blurry
(most visible on small text). pdf.js v5 does **not** apply DPR itself.

### 1.4 Atomic offscreen render + swap
pdf.js paints in async chunks; a **cancelled** render can still land chunks on
its canvas. Reusing one canvas across zoom levels leaves a stale frame under the
new one. Render canvas **and** text layer offscreen, then swap both into the DOM
in one step (`canvasHost.replaceChildren(nextCanvas)`,
`textLayerHost.replaceChildren(...nextLayer.childNodes)`), and set the scale
variables on the wrapper in the same tick.

### 1.5 Assets, worker, versions
- `pdfjs-dist` is nested in `packages/plugin-paper/node_modules` (5.7.x); the root
  copy (5.4.x) belongs to `pdf-parse` (server side). They differ — check which one
  the client bundle resolves.
- `TextLayer` is exported from the **main entry** (`pdfjs-dist`), not from
  `web/pdf_viewer.mjs` (that only has `TextLayerBuilder`).
- Worker: Vite `?url` import + `GlobalWorkerOptions.workerSrc`.
- Runtime assets must exist at `packages/client/public/pdfjs/{cmaps,standard_fonts,wasm}`
  and be referenced via `getDocument({ cMapUrl: "/pdfjs/cmaps/", … })`.

### 1.6 Plugin wiring
- Register the UI **statically** in `packages/client/src/pi-tree.config.ts`.
- **Never** add a `piTree.ui` field to `plugin-paper/package.json`: that routes the
  plugin through the runtime IIFE loader and double-registers it (and esbuild
  cannot handle the pdf.js worker there).

### 1.7 Paper source semantics
- `plugin-paper` has `hasProcessing: true`: `POST /api/library/sources/create`
  now returns `status: "pending"` and enqueues processing. e2e expectations must
  match (see `e2e/add-source.spec.ts`).
- arXiv content is fetched over the network (ar5iv first, PDF text fallback);
  unit/e2e tests must not depend on it.

## 2. Verification recipes (use these, do not eyeball)

```js
// Playwright: Retina matters — DPR=1 hides HiDPI bugs
const page = await browser.newPage({ viewport: { width: 1512, height: 982 },
                                     deviceScaleFactor: 2 });
```

- **Selection ghost repro** (the case that took longest to find):
  ```js
  const layer = document.querySelector('.pdf-page-text-layer');
  const r = document.createRange(); r.selectNodeContents(layer);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  // then screenshot; compare against the unselected screenshot
  ```
- **Alignment metric**: fraction of dark pixels inside text-layer span boxes
  (`ink`). Aligned ≈ 0.17–0.21; below ≈ 0.05 means real misalignment.
- **Ghost metric**: re-render the same page offscreen and diff pixels **with the
  exact same parameters** (`transform: [dpr,0,0,dpr,0,0]`, same canvas size as
  `floor(viewport.width * dpr)`). Using `canvas.width / cssWidth` as the reference
  scale introduces a ≈0.001 scale mismatch → full-page AA noise → false positives.
- **Layer bisection**: temporarily hide `.pdf-page-canvas-host` / `.pdf-page-text-layer`
  and ask the user to look. When the artifact lives in the compositor, the user's
  eyes are the only reliable detector.
- **Known-good reference**: Chrome's built-in PDF viewer (drag the PDF into a tab).
  If it is clean and we are not, the difference is in our layers/styles — not in
  the display.

## 3. Traps table

| Symptom | Cause | Fix |
|---|---|---|
| Text overlapping/garbled at the initial scale | text layer scale contract missing (§1.1) | set `--total-scale-factor` + copy the v5 rules |
| Doubled text **only when text is selected** | global `::selection { color }` reveals the layer (§1.2) | keep the layer transparent on selection |
| Blurry/smeared text on Retina | bitmap not rendered at DPR (§1.3) | size + transform by `devicePixelRatio` |
| Ghost of a previous zoom level | cancelled render lands chunks on a reused canvas (§1.4) | offscreen render + atomic swap |
| `MISSING_EXPORT "TextLayer"` at build | imported from `web/pdf_viewer.mjs` (§1.5) | import from `pdfjs-dist` main entry |
| CJK glyphs missing | cmaps not copied/served (§1.5) | copy assets + `cMapUrl` |
| Plugin UI registered twice / worker errors | `piTree.ui` added (§1.6) | static registration only |
| e2e fails expecting `status: "ready"` for papers | `hasProcessing: true` (§1.7) | expect `pending` |
