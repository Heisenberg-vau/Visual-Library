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
- **Annotations (milestone 2)** will live in a new IndexedDB store keyed by
  book + page, in page-relative coordinates (0..1) so they survive zoom and
  re-layout, drawn on a separate canvas layer above each page.
- **Duplicate detection** uses SHA-256 of size + first/last MB, not the pdf.js
  fingerprint (which collides for PDFs without a trailer /ID).
- **Schema changes** to IndexedDB only add stores/indexes in `idb.ts`
  `onupgradeneeded`; existing user data is never dropped.

## Testing

- `tests/unit` (Vitest): layout maths, scheduler, cache, library use-cases.
- `tests/e2e` (Playwright + real Chrome, tablet viewport with touch): import,
  duplicates, 650-page navigation, outline, thumbnails, pinch zoom, position
  memory, reload, offline, 200 MB file (`HEAVY=1`), delete.
