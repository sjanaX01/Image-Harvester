"""Scrape control routes: start, status, cancel."""

import asyncio
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.scraper import ImageScraper
from app.models import ScrapeConfig
from routes.jobs import jobs

router = APIRouter()


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


@router.post("/start")
async def start_scrape(request: Request):
    data = await request.json()
    url = data.get("url", "").strip()
    if not url:
        return JSONResponse({"error": "URL is required"}, status_code=400)

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    max_depth = min(max(int(data.get("max_depth", 2)), 0), 10)
    max_pages = min(max(int(data.get("max_pages", 50)), 1), 1000)

    config = ScrapeConfig(
        start_url=url,
        max_depth=max_depth,
        max_pages=max_pages,
        follow_links=data.get("follow_links", True),
        exhaust_all=data.get("exhaust_all", False),
        detect_fullres=data.get("detect_fullres", False),
        same_domain_only=data.get("same_domain_only", True),
        respect_robots=data.get("respect_robots", True),
    )

    job_id = str(uuid.uuid4())[:8]
    scraper = ImageScraper(config=config)
    jobs[job_id] = {"id": job_id, "scraper": scraper, "task": None, "status": "starting"}
    jobs[job_id]["task"] = asyncio.create_task(_run_scraper(job_id))

    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)

    scraper = job["scraper"]
    p = scraper.progress

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

    crawl_nodes = [
        {
            "id": n.id, "url": n.url, "label": n.label,
            "depth": n.depth, "status": n.status,
            "image_count": n.image_count,
        }
        for n in scraper.crawl_nodes
    ]

    return {
        "status": p.status,
        "current_url": p.current_url,
        "image_count": p.image_count,
        "pages_scraped": p.visited_count,
        "queue_size": p.queue_size,
        "images": [img.url for img in scraper.images],
        "image_details": image_details,
        "log": scraper.activity_log[-60:],
        "crawl_nodes": crawl_nodes,
        "crawl_edges": scraper.crawl_edges,
        "queue_urls": scraper.queue_urls[-200:],
        "zip_progress": scraper.zip_progress,
        "raw_pages": scraper.raw_pages,
        "crawl_events": scraper.crawl_events[-200:],
    }


@router.post("/cancel/{job_id}")
async def cancel_scrape(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    job["scraper"].stop()
    return {"ok": True}
