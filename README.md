# Image Scraper

A web-based image scraper with a clean, minimal UI. Provide a website URL and it crawls pages to collect all images, with an option to download them as a ZIP bundle.

## Features

- **Queue-based crawling** — discovered links are queued and processed one by one
- **Depth limit** — configurable 1–3 levels to prevent runaway crawling
- **Domain lock** — only follows links within the same domain
- **Deduplication** — tracks visited URLs to avoid re-scraping
- **Image filtering** — filter by format (JPG, PNG, SVG, WebP, GIF) and minimum file size
- **Live progress** — real-time updates via WebSocket showing current URL, queue size, and image count
- **ZIP download** — download all scraped images as a single ZIP file
- **Image preview** — click any image to view it in a modal with metadata
- **Robots.txt** — respects robots.txt by default

## Quick Start

```bash
pip install -r requirements.txt
python main.py
```

Open **http://localhost:8000** in your browser.

## Tech Stack

- **Backend:** FastAPI + aiohttp + BeautifulSoup
- **Frontend:** Vanilla HTML/CSS/JS with WebSocket
- **Theme:** Single slate-blue color palette, minimal design