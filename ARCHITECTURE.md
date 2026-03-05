# ImageHarvest — Architecture Map

> Quick-reference for every file in the project and what it does.

---

## Entry Point

| File | Responsibility |
|------|---------------|
| `main.py` | FastAPI app factory — creates the `app`, includes `scrape_router` and `download_router`, mounts `/static`, serves `GET /` |

---

## Backend — `app/` package

Core logic, no FastAPI imports allowed here.

| File | Responsibility |
|------|---------------|
| `app/__init__.py` | Empty package marker |
| `app/constants.py` | `IMAGE_EXTENSIONS` set, `DEFAULT_HEADERS` browser UA dict |
| `app/models.py` | `ScrapedImage`, `ScrapeConfig`, `CrawlNode`, `ScrapeProgress` dataclasses |
| `app/url_utils.py` | `normalize_url`, `is_same_domain`, `is_image_url`, `is_likely_image_url`, `is_valid_page_url`, `matches_format_filter` |
| `app/page_parser.py` | `extract_raw_data` (headers/meta/links), `extract_image_urls` (img tags, srcset, data-attrs), `extract_page_links` (anchor hrefs) |
| `app/fullres.py` | Full-resolution resolver — CDN transforms, URL param stripping, path transforms, HEAD-probe; exports `resolve_fullres(session, thumb_url)` |
| `app/downloader.py` | `download_images_zip(images, selected_urls, stop_flag_fn, on_progress)` — creates its own `aiohttp.ClientSession`, streams a ZIP to a `BytesIO` buffer |
| `app/scraper.py` | `ImageScraper` class — async BFS crawler; uses all `app/*` modules; exposes `run()`, `stop()`, `download_images_zip()` |

---

## Backend — `routes/` package

FastAPI route handlers; all state lives in `routes/jobs.py`.

| File | Responsibility |
|------|---------------|
| `routes/__init__.py` | Empty package marker |
| `routes/jobs.py` | Shared in-memory `jobs: dict[str, dict]` store |
| `routes/scrape.py` | `APIRouter` — `POST /start`, `GET /status/{job_id}`, `POST /cancel/{job_id}` |
| `routes/download.py` | `APIRouter` — `GET /download/{job_id}`, `POST /download-selected/{job_id}` |

---

## Root-level shims (legacy compatibility)

| File | Responsibility |
|------|---------------|
| `scraper.py` | Re-exports `ImageScraper`, `ScrapeConfig`, `DEFAULT_HEADERS`, `IMAGE_EXTENSIONS` from `app.*` |

---

## Frontend — `static/`

### HTML

| File | Responsibility |
|------|---------------|
| `static/index.html` | Single-page app shell — sidebar, tab headers, all panel HTML, overlays |

### CSS — `static/css/`

Load order matters: `variables.css` must be first.

| File | Responsibility |
|------|---------------|
| `variables.css` | CSS custom properties (`:root` light theme + `[data-theme="dark"]` overrides), `*` reset, `html/body` |
| `layout.css` | Shell, header, logo, view-tabs, badge, theme button, warn-msg, sidebar sections, main panel |
| `controls.css` | Toggle switches, action buttons, stats grid, status pill, blink animation, current-url |
| `gallery.css` | Gallery wrap, section dividers, image cards, selection bar, empty state, export buttons |
| `download.css` | Download dropdown, option rows, ZIP overlay progress bar |
| `graph.css` | Graph panel, SVG container, graph controls, node tooltip |
| `queue.css` | Queue wrap, queue items, depth badge |
| `log.css` | Log panel, resize handle, log lines, minimized state |
| `overlays.css` | Image detail overlay, lightbox, ZIP progress overlay, scrollbar styling |
| `rawdata.css` | Raw Data panel toolbar, section cards, key-value rows, live feed event cards |

### JavaScript — `static/js/`

Load order matters: `state.js` first, `graph.js` before files that call `NODE_COLORS`.

| File | Responsibility |
|------|---------------|
| `state.js` | Global state vars, `toggleTheme`, `updateThemeIcon`, `updateGraphRootColor`, theme IIFE, `showWarn`/`hideWarn` |
| `graph.js` | `NODE_COLORS`, D3 force simulation, `renderGraph`, `initGraphSvg`, `resetGraphState`, zoom/center, tooltip |
| `controls.js` | `switchView`, `toggleOption` (all 5 toggles), `updateDepthSection` |
| `log.js` | `updateLog`, `toggleLog`, `initLogResize` (RAF-based smooth resize) |
| `queue.js` | `updateQueue` |
| `gallery.js` | `renderNewImages`, `rebuildGallery`, `makeSectionHeader`, `toggleSection`, `createImageCard`, `toggleSelect`, `toggleSelectAll`, `clearSelection`, `updateSelBar` |
| `detail.js` | `openDetail`, `closeDetail`, `detailOpenOriginal`, `detailOpenSource`, `detailToggleSelect`, `detailDownloadSingle`, `updateDetailSelectBtn` |
| `download.js` | `toggleDlMenu`, `closeDlMenu`, `updateDlCounts`, `downloadCategory`, `showZipProgress`, `exportImages`, `exportRawData`, `triggerDownload`, `csvEsc` |
| `rawdata.js` | `toggleRawLive`, `updateRawPageSelect`, `updateRawDataView`, `renderRawPage`, `renderRawLive`, `truncUrl`, `esc` |
| `scraper.js` | `startScrape`, `poll`, `cancelScrape`, `setStatus`, `setStats` |
| `init.js` | `DOMContentLoaded` — wires log resizers, URL input Enter key |

---

## Other files

| File | Responsibility |
|------|---------------|
| `pyproject.toml` | Project metadata and dependencies |
| `requirements.txt` | Pinned Python dependencies |
| `uv.lock` | Lock file for `uv` package manager |
| `downloads/` | Runtime directory where downloaded ZIPs are saved |
| `static/style.css` | **Legacy** — original monolithic CSS (no longer linked; superseded by `static/css/`) |
| `static/script.js` | **Legacy** — original monolithic JS (no longer linked; superseded by `static/js/`) |

---

## Data-flow summary

```
Browser ──POST /start──► routes/scrape.py
                              │
                    creates ImageScraper (app/scraper.py)
                              │
              BFS crawl using aiohttp.ClientSession
                    ┌─────────┴──────────┐
             page_parser.py          fullres.py
             (extract images,        (resolve full-res
              links, raw data)        candidates)
                    └─────────┬──────────┘
                       stores in scraper.images,
                       scraper.raw_pages, etc.
                              │
Browser ──GET /status──► routes/scrape.py ──► JSON response
Browser ──POST /download-selected──► routes/download.py
                              │
                    downloader.download_images_zip()
                              │
                         ZIP stream ──► browser
```
