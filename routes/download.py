"""Download routes: ZIP all images, ZIP selected images."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from routes.jobs import jobs

router = APIRouter()


@router.get("/download/{job_id}")
async def download_zip(job_id: str):
    job = jobs.get(job_id)
    if not job or not job["scraper"].images:
        return JSONResponse({"error": "No images to download"}, status_code=404)

    scraper = job["scraper"]
    buf = await scraper.download_images_zip()

    domain = scraper.base_domain.replace(".", "_")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{domain}_images.zip"'},
    )


@router.post("/download-selected/{job_id}")
async def download_selected(job_id: str, request: Request):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)

    data = await request.json()
    selected = data.get("urls", [])
    if not selected:
        return JSONResponse({"error": "No images selected"}, status_code=400)

    scraper = job["scraper"]
    buf = await scraper.download_images_zip(selected_urls=selected)

    domain = scraper.base_domain.replace(".", "_")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{domain}_selected.zip"'},
    )
