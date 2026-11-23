# Architecture

Layers depend only downward. UI can be redesigned without touching `core/`;
storage or the PDF engine can change without touching UI.

```
src/
  app/App.ts            composition root: builds services, switches screens
  ui/                   DOM only; all look-and-feel in ui/styles.css
    library/            bookshelf screen
    reader/             ReaderView (toolbar, panels), PageScroller (virtualised
                        page view + pinch zoom), ThumbnailPanel, OutlinePanel
    dom.ts, feedback.ts helpers, toasts, dialogs
  core/                 no DOM-layout code; unit-tested
    types.ts            BookMeta, OutlineNode, PageSize
    pdf/                PagedDocument interface + pdf.js implementation
    storage/            IndexedDB metadata, OPFS original files, LibraryService
    util/               PageLayout geometry, LRU cache, job scheduler, fingerprint
```

## Key decisions

- **Originals are immutable.** Imported files are copied once into the Origin
  Private File System and never written again. Annotated exports (milestone 3)
  produce new files.
- **Large files stay on disk.** pdf.js reads byte ranges straight from the OPFS
  file (`FileRangeTransport`), so a 200 MB PDF uses only a few MB of JS memory.
- **Only nearby pages exist.** `PageScroller` keeps DOM nodes and canvases for
  pages around the viewport; a shared `JobScheduler` renders the visible page
  first and cancels work for pages that scrolled away.
- **`PagedDocument` abstraction.** The reader, pen tools and export work on this
  interface. `.docx` (milestone 6) will be converted to the same shape.
- **Handwriting** (`core/annotations`): strokes stored per (book, page) in the
  IndexedDB `ink` store, in PDF points relative to the original page, so they
  survive zoom and re-layout and export 1:1. Ink in a widened margin has x < 0
  or x > page width. `InkModel` holds undo/redo and debounced saving;
  `ui/reader/InkLayer` draws it on three canvases per visible page
  (highlighter blended *multiply*, pen, live stroke).
- **Text-aware marking** (`core/text`): pdf.js text runs become character
  boxes (glyph widths measured per font family). The highlighter covers the
  characters its stroke passes over (any direction); the underline sits a fixed
  distance under the baseline. Scans without text fall back to freehand.
- **Export** (`core/export`): `ExportService` builds one job per page (ink,
  display→PDF matrix from pdf.js, margins) on the main thread; a Web Worker
  runs pdf-lib to draw the same path commands the screen uses (`path.ts`) into
  a NEW file. The original's content is wrapped in q…Q, highlights use an
  ExtGState with Multiply blend, widened pages get larger Media/CropBoxes.
- **Notebooks** (`core/notebook`): a notebook is a `BookMeta` of kind
  `notebook` (so shelves, tags, search and select work unchanged) and a
  `NotebookDocument` that implements `PagedDocument` with ruled/grid/dot paper.
  Ink reuses `InkModel`/`InkStore`. Page-link tags are strokes of tool `link`
  (so undo, eraser, saving and export come for free). The reader shows a
  notebook beside a book in a resizable split (`NotebookPane`); undo/redo
  follow the pane last written in; the last notebook per book reopens.
- **Input rules:** pen (and mouse, for laptops) writes; fingers only scroll and
  pinch. Stylus touches are `preventDefault`-ed so the page never scrolls under
  the pen, and touches are ignored for 250 ms after pen activity (palm).
- **Duplicate detection** uses SHA-256 of size + first/last MB, not the pdf.js
  fingerprint (which collides for PDFs without a trailer /ID).
- **Schema changes** to IndexedDB only add stores/indexes in `idb.ts`
  `onupgradeneeded`; existing user data is never dropped.

## Testing

- `tests/unit` (Vitest): layout maths, scheduler, cache, library use-cases.
- `tests/e2e` (Playwright + real Chrome, tablet viewport with touch): import,
  duplicates, 650-page navigation, outline, thumbnails, pinch zoom, position
  memory, reload, offline, 200 MB file (`HEAVY=1`), delete, shelves/tags,
  v0.1 data upgrade, and handwriting with a simulated stylus (CDP pen events).
