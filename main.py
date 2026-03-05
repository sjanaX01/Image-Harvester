import asyncio
import uuid
from typing import Optional

import aiohttp
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from scraper import ImageScraper, ScrapeConfig

app = FastAPI(title="ImageHarvest")

# ── State ────────────────────────────────────────────────────────────────
jobs: dict[str, dict] = {}


# ── Routes ───────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.post("/start")
async def start_scrape(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if not url:
        return JSONResponse({"error": "URL is required"}, status_code=400)

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    max_depth = min(max(int(data.get("max_depth", 2)), 0), 10)
    max_pages = min(max(int(data.get("max_pages", 50)), 1), 1000)
    follow_links = data.get("follow_links", True)
    exhaust_all = data.get("exhaust_all", False)
    detect_fullres = data.get("detect_fullres", False)

    config = ScrapeConfig(
        start_url=url,
        max_depth=max_depth,
        max_pages=max_pages,
        follow_links=follow_links,
        exhaust_all=exhaust_all,
        detect_fullres=detect_fullres,
    )

    job_id = str(uuid.uuid4())[:8]
    scraper = ImageScraper(config=config)
    job = {
        "id": job_id,
        "scraper": scraper,
        "task": None,
        "status": "starting",
    }
    jobs[job_id] = job

    task = asyncio.create_task(_run_scraper(job_id))
    job["task"] = task

    return {"job_id": job_id}


async def _run_scraper(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return
    try:
        await job["scraper"].run()
    except Exception as e:
        job["scraper"]._log(f"✗ Error: {e}")
        job["scraper"].progress.status = "done"
        job["scraper"].progress.message = f"Error: {e}"


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)

    scraper = job["scraper"]
    p = scraper.progress

    # Serialize images
    images = [img.url for img in scraper.images]

    # Full image data for the dashboard
    image_details = [
        {
            "url": img.url,
            "filename": img.filename,
            "source_page": img.source_page,
            "file_size": img.file_size,
            "is_thumbnail": img.is_thumbnail,
            "fullres_url": img.fullres_url,
        }
        for img in scraper.images
    ]

    # Crawl graph
    crawl_nodes = [
        {
            "id": n.id, "url": n.url, "label": n.label,
            "depth": n.depth, "status": n.status,
            "image_count": n.image_count,
        }
        for n in scraper.crawl_nodes
    ]
    crawl_edges = scraper.crawl_edges

    # Queue
    queue_urls = scraper.queue_urls[-200:]

    return {
        "status": p.status,
        "current_url": p.current_url,
        "image_count": p.image_count,
        "pages_scraped": p.visited_count,
        "queue_size": p.queue_size,
        "images": images,
        "image_details": image_details,
        "log": scraper.activity_log[-60:],
        "crawl_nodes": crawl_nodes,
        "crawl_edges": crawl_edges,
        "queue_urls": queue_urls,
        "zip_progress": scraper.zip_progress,
    }


@app.post("/cancel/{job_id}")
async def cancel_scrape(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    job["scraper"].stop()
    return {"ok": True}


@app.get("/download/{job_id}")
async def download_zip(job_id: str):
    job = jobs.get(job_id)
    if not job or not job["scraper"].images:
        return JSONResponse({"error": "No images to download"}, status_code=404)

    scraper = job["scraper"]
    async with aiohttp.ClientSession() as session:
        buf = await scraper.download_images_zip(session)

    domain = scraper.base_domain.replace(".", "_")
    filename = f"{domain}_images.zip"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/download-selected/{job_id}")
async def download_selected(job_id: str, request: Request):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)

    data = await request.json()
    selected = data.get("urls", [])
    if not selected:
        return JSONResponse({"error": "No images selected"}, status_code=400)

    scraper = job["scraper"]
    async with aiohttp.ClientSession() as session:
        buf = await scraper.download_images_zip(session, selected_urls=selected)

    domain = scraper.base_domain.replace(".", "_")
    filename = f"{domain}_selected.zip"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Static files (mounted last so it doesn't override routes) ────────────
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
