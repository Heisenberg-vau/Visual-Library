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
  interface. `.docx` (milestone 8) is converted to the same shape: docx-preview
  lays it out in an isolated iframe, `core/docx/paginate.ts` splits the flow
  into pages between lines, each page is drawn via SVG foreignObject (data: URL,
  so the canvas stays exportable) and assembled into a reading-copy PDF with
  pdf-lib. The original is kept under `<id>.orig`; word boxes from the layout go
  into the text index as source "docx", so those pages are never OCR'd.
- Clips (book → notebook) are strokes with `tool: "clip"`: `rects` is the box,
  `clip` holds a picture (data: URL) or text pre-wrapped into lines, `link` the
  source page. They live in the same undo/persist/export path as ink; a move is
  one `replace` op. Text clips are drawn into pictures at export time because
  standard PDF fonts lack Vietnamese letters.
- Indexing/OCR is app-wide (`app/IndexService.ts`): it starts right after
  import, one book at a time; the open book and its current pages go first.
  Pages whose PDF text is fine keep it; every other page (scan, broken or
  repaired encoding) is OCR'd.
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
- **Study** (`core/study`, `ui/study`): `StudyTimer` is a pure state machine
  (clock passed in) that only *suggests* breaks; `StudySession` drives it
  app-wide, logs focus time per day/book (`study` store) and survives reloads.
  `PlannerView` manages tasks/deadlines (`tasks` store, DB v4). `Ambience`
  adds screen-only overlays (dim, warm), page tone via CSS filters, and
  Web Audio generated rain/brown/white noise.
- **Reading progress** (`core/study/reading.ts`, DB v5): a page counts as read
  after 8 s as the main page; a per-book bitset gives "pages actually read"
  for non-linear reading, plus a per-day set for the optional daily goal.
- **Search & OCR** (`core/text`, DB v6 `pageText`): `TextIndexer` reads each
  page's text (fonts with shifted codes are repaired per font by
  `encoding.ts`), marks scans and unreadable pages "pending", then OCRs them
  with Tesseract (offline, eng+vie, nearest page first) and stores words with
  boxes. Search is accent-insensitive over those words; OCR words also feed
  highlight/underline snapping on scans.
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
