"""Standalone async ZIP builder for scraped images."""

import io
import os
import zipfile
from typing import Callable, Optional
from urllib.parse import urlparse

import aiohttp

from app.constants import DEFAULT_HEADERS


async def download_images_zip(
    images: list,
    selected_urls: Optional[list[str]] = None,
    stop_flag_fn: Callable[[], bool] = lambda: False,
    on_progress: Optional[Callable] = None,
) -> io.BytesIO:
    """Download `images` (list of ScrapedImage) into an in-memory ZIP.

    Args:
        images: list of ScrapedImage dataclass instances.
        selected_urls: if given, only images whose .url is in this list are included.
        stop_flag_fn: zero-arg callable that returns True if the operation should abort.
        on_progress: async callable called with progress dict after each image.

    Returns:
        BytesIO of the complete ZIP, seeked to position 0.
    """
    buf = io.BytesIO()
    seen_filenames: dict[str, int] = {}

    imgs_to_download = (
        [img for img in images if img.url in selected_urls]
        if selected_urls
        else list(images)
    )

    total = len(imgs_to_download)
    dl_headers = {
        **DEFAULT_HEADERS,
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
    }

    connector = aiohttp.TCPConnector(limit=5)
    async with aiohttp.ClientSession(
        connector=connector, headers=dl_headers
    ) as session:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, img in enumerate(imgs_to_download):
                if stop_flag_fn():
                    break
                try:
                    timeout = aiohttp.ClientTimeout(total=20)
                    async with session.get(img.url, timeout=timeout, ssl=False) as resp:
                        if not (200 <= resp.status < 300):
                            continue
                        data = await resp.read()

                    folder = "thumbnails/" if img.is_thumbnail else ""
                    fname = img.filename or "image"
                    full_path = folder + fname

                    if full_path in seen_filenames:
                        seen_filenames[full_path] += 1
                        name, ext = os.path.splitext(fname)
                        full_path = f"{folder}{name}_{seen_filenames[full_path]}{ext}"
                    else:
                        seen_filenames[full_path] = 0

                    zf.writestr(full_path, data)

                    if on_progress:
                        await on_progress({
                            "status": "zipping",
                            "current": i + 1,
                            "total": total,
                            "filename": fname,
                        })
                except Exception:
                    continue

    buf.seek(0)
    return buf
