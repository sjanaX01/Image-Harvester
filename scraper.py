import asyncio
import hashlib
import io
import os
import re
import zipfile
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse, unquote
from urllib.robotparser import RobotFileParser

import aiohttp
from bs4 import BeautifulSoup

IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
    ".bmp", ".ico", ".tiff", ".tif",
}

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass
class ScrapedImage:
    url: str
    source_page: str
    file_size: int = 0
    content_type: str = ""
    filename: str = ""
    is_thumbnail: bool = False
    fullres_url: str = ""  # full-resolution counterpart if detected


@dataclass
class ScrapeConfig:
    start_url: str
    max_depth: int = 2
    max_pages: int = 100
    follow_links: bool = True
    exhaust_all: bool = False
    allowed_formats: set = field(
        default_factory=lambda: {"jpg", "jpeg", "png", "gif", "svg", "webp"}
    )
    min_file_size: int = 0
    respect_robots: bool = True
    max_concurrent: int = 5
    request_timeout: int = 15
    request_delay: float = 0.2
    detect_fullres: bool = False


@dataclass
class CrawlNode:
    id: str
    url: str
    label: str
    depth: int
    status: str = "pending"  # pending, scraping, done, error
    image_count: int = 0
    parent_id: str = ""


@dataclass
class ScrapeProgress:
    current_url: str = ""
    queue_size: int = 0
    visited_count: int = 0
    image_count: int = 0
    status: str = "idle"
    message: str = ""


class ImageScraper:
    def __init__(self, config: ScrapeConfig, on_progress: Optional[Callable] = None):
        self.config = config
        self.on_progress = on_progress

        parsed = urlparse(config.start_url)
        self.base_domain = parsed.netloc
        self.base_scheme = parsed.scheme or "https"

        self.visited_urls: set[str] = set()
        self.image_urls: set[str] = set()
        self.images: list[ScrapedImage] = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.progress = ScrapeProgress()
        self._stop_flag = False
        self._robots_parser: Optional[RobotFileParser] = None
        self.activity_log: list[str] = []

        # Graph
        self.crawl_nodes: list[CrawlNode] = []
        self.crawl_edges: list[dict] = []
        self._node_map: dict[str, CrawlNode] = {}
        self._node_counter = 0

        # Queue tracking
        self.queue_urls: list[dict] = []
        self._queued_set: set[str] = set()

        # Zip progress
        self.zip_progress: dict = {"status": "idle", "current": 0, "total": 0, "filename": ""}

    def _log(self, msg: str):
        self.activity_log.append(msg)
        if len(self.activity_log) > 200:
            self.activity_log = self.activity_log[-150:]

    def _make_node_id(self) -> str:
        self._node_counter += 1
        return f"n{self._node_counter}"

    def _add_crawl_node(self, url: str, depth: int, parent_id: str = "") -> CrawlNode:
        if url in self._node_map:
            return self._node_map[url]
        nid = self._make_node_id()
        parsed = urlparse(url)
        path = parsed.path or "/"
        if len(path) > 30:
            path = "…" + path[-27:]
        node = CrawlNode(id=nid, url=url, label=path, depth=depth, parent_id=parent_id)
        self.crawl_nodes.append(node)
        self._node_map[url] = node
        if parent_id:
            self.crawl_edges.append({"source": parent_id, "target": nid})
        return node

    async def _emit_progress(self):
        if self.on_progress:
            await self.on_progress(self.progress)

    def _normalize_url(self, url: str) -> str:
        parsed = urlparse(url)
        normalized = parsed._replace(fragment="")
        result = normalized.geturl()
        if result.endswith("/") and parsed.path != "/":
            result = result.rstrip("/")
        return result

    def _is_same_domain(self, url: str) -> bool:
        parsed = urlparse(url)
        target = parsed.netloc.lower()
        base = self.base_domain.lower()
        return target == base

    def _is_valid_page_url(self, url: str) -> bool:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https", ""):
            return False
        if not self._is_same_domain(url):
            return False
        skip_extensions = {
            ".pdf", ".doc", ".docx", ".xls", ".xlsx",
            ".zip", ".rar", ".tar", ".gz",
            ".mp3", ".mp4", ".avi", ".mov", ".wmv",
            ".css", ".js", ".json", ".xml",
        }
        path_lower = parsed.path.lower()
        # Also skip image extensions (they're files, not pages)
        for ext in skip_extensions | IMAGE_EXTENSIONS:
            if path_lower.endswith(ext):
                return False
        return True

    def _is_image_url(self, url: str) -> bool:
        parsed = urlparse(url)
        path_lower = unquote(parsed.path).lower()
        return any(path_lower.endswith(ext) for ext in IMAGE_EXTENSIONS)

    def _matches_format_filter(self, url: str) -> bool:
        parsed = urlparse(url)
        path_lower = unquote(parsed.path).lower()
        for fmt in self.config.allowed_formats:
            fmt_clean = fmt.lower().strip(".")
            if path_lower.endswith(f".{fmt_clean}"):
                return True
        if not any(path_lower.endswith(ext) for ext in IMAGE_EXTENSIONS):
            return True
        return False

    async def _check_robots(self, session: aiohttp.ClientSession):
        if not self.config.respect_robots:
            return
        robots_url = f"{self.base_scheme}://{self.base_domain}/robots.txt"
        try:
            async with session.get(
                robots_url, timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status == 200:
                    text = await resp.text()
                    self._robots_parser = RobotFileParser()
                    self._robots_parser.parse(text.splitlines())
        except Exception:
            self._robots_parser = None

    def _can_fetch(self, url: str) -> bool:
        if not self.config.respect_robots or self._robots_parser is None:
            return True
        return self._robots_parser.can_fetch("*", url)

    def _extract_image_urls(self, soup: BeautifulSoup, page_url: str) -> list[dict]:
        """Extract image URLs. Returns list of {url, is_thumbnail, fullres_url}."""
        results = []
        seen_in_page = set()

        def add_img(img_url, is_thumb=False, fullres=""):
            img_url = self._normalize_url(img_url)
            if img_url not in seen_in_page:
                seen_in_page.add(img_url)
                results.append({"url": img_url, "is_thumbnail": is_thumb, "fullres_url": fullres})

        # <img src="..."> — also check if wrapped in <a> linking to full-res
        for img in soup.find_all("img"):
            src = img.get("src")
            if not src:
                continue
            img_url = urljoin(page_url, src)

            # Check parent <a> for full-resolution link
            fullres = ""
            parent_a = img.find_parent("a")
            if parent_a and parent_a.get("href"):
                a_href = urljoin(page_url, parent_a["href"])
                if self._is_image_url(a_href) and a_href != img_url:
                    fullres = a_href

            is_thumb = bool(fullres)
            add_img(img_url, is_thumb=is_thumb, fullres=fullres)

            # If detect_fullres and there's a full-res, add it too
            if fullres and self.config.detect_fullres:
                add_img(fullres, is_thumb=False, fullres="")

            # srcset
            srcset = img.get("srcset")
            if srcset:
                for entry in srcset.split(","):
                    parts = entry.strip().split()
                    if parts:
                        add_img(urljoin(page_url, parts[0]))

            # data-src (lazy loading)
            data_src = img.get("data-src")
            if data_src:
                add_img(urljoin(page_url, data_src))

        # <picture><source srcset="...">
        for source in soup.find_all("source"):
            srcset = source.get("srcset")
            if srcset:
                for entry in srcset.split(","):
                    parts = entry.strip().split()
                    if parts:
                        add_img(urljoin(page_url, parts[0]))

        # CSS background-image in inline styles
        for tag in soup.find_all(style=True):
            style = tag["style"]
            urls = re.findall(r'url\(["\']?(.*?)["\']?\)', style)
            for u in urls:
                full_url = urljoin(page_url, u)
                if self._is_image_url(full_url):
                    add_img(full_url)

        # <a> tags linking directly to images (not already caught)
        for a in soup.find_all("a", href=True):
            href = urljoin(page_url, a["href"])
            if self._is_image_url(href):
                add_img(href)

        # <meta property="og:image">
        for meta in soup.find_all("meta", attrs={"property": "og:image"}):
            content = meta.get("content")
            if content:
                add_img(urljoin(page_url, content))

        return results

    def _extract_page_links(self, soup: BeautifulSoup, page_url: str) -> list[str]:
        """Extract all same-domain page links from parsed HTML."""
        links = []
        seen = set()
        for a in soup.find_all("a", href=True):
            raw_href = a["href"].strip()
            # Skip empty, fragment-only, javascript:, mailto:, tel:
            if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            href = urljoin(page_url, raw_href)
            href = self._normalize_url(href)
            if href in seen:
                continue
            seen.add(href)
            if self._is_valid_page_url(href):
                links.append(href)
        return links

    async def _fetch_page(
        self, session: aiohttp.ClientSession, url: str
    ) -> Optional[str]:
        try:
            timeout = aiohttp.ClientTimeout(total=self.config.request_timeout)
            async with session.get(
                url, timeout=timeout, headers=DEFAULT_HEADERS, ssl=False,
                allow_redirects=True,
            ) as resp:
                if resp.status != 200:
                    return None
                content_type = resp.headers.get("content-type", "")
                if "text/html" not in content_type and "application/xhtml" not in content_type:
                    return None
                return await resp.text(errors="replace")
        except Exception:
            return None

    async def _get_image_info(
        self, session: aiohttp.ClientSession, url: str
    ) -> Optional[tuple[int, str]]:
        try:
            timeout = aiohttp.ClientTimeout(total=8)
            async with session.head(
                url, timeout=timeout, headers=DEFAULT_HEADERS, ssl=False
            ) as resp:
                if resp.status == 200:
                    size = int(resp.headers.get("content-length", 0))
                    ct = resp.headers.get("content-type", "")
                    return size, ct
                async with session.get(
                    url, timeout=timeout,
                    headers={**DEFAULT_HEADERS, "Range": "bytes=0-0"},
                    ssl=False,
                ) as resp2:
                    size = 0
                    cr = resp2.headers.get("content-range", "")
                    if "/" in cr:
                        try:
                            size = int(cr.split("/")[-1])
                        except ValueError:
                            pass
                    ct = resp2.headers.get("content-type", "")
                    return size, ct
        except Exception:
            return None

    async def _process_url(
        self, session: aiohttp.ClientSession, url: str, depth: int
    ):
        if self._stop_flag:
            return

        if not self._can_fetch(url):
            self._log(f"✗ Blocked by robots.txt: {url}")
            return

        # Update graph node
        node = self._node_map.get(url)
        if node:
            node.status = "scraping"

        self.progress.current_url = url
        self.progress.queue_size = self.queue.qsize()
        self.progress.visited_count = len(self.visited_urls)
        self.progress.message = f"Scraping: {url}"
        await self._emit_progress()

        self._log(f"→ Fetching: {url}")
        html = await self._fetch_page(session, url)
        if html is None:
            self._log(f"✗ Failed to fetch: {url}")
            if node:
                node.status = "error"
            return

        soup = BeautifulSoup(html, "lxml")

        # Extract images
        images_before = len(self.images)
        raw_images = self._extract_image_urls(soup, url)

        for img_data in raw_images:
            img_url = img_data["url"]
            if img_url in self.image_urls:
                continue
            if not self._matches_format_filter(img_url):
                continue

            if self.config.min_file_size > 0:
                info = await self._get_image_info(session, img_url)
                if info:
                    size, ct = info
                    if size > 0 and size < self.config.min_file_size:
                        continue
                    self.image_urls.add(img_url)
                    filename = os.path.basename(urlparse(img_url).path) or "image"
                    self.images.append(ScrapedImage(
                        url=img_url, source_page=url, file_size=size,
                        content_type=ct, filename=filename,
                        is_thumbnail=img_data["is_thumbnail"],
                        fullres_url=img_data.get("fullres_url", ""),
                    ))
                else:
                    self.image_urls.add(img_url)
                    filename = os.path.basename(urlparse(img_url).path) or "image"
                    self.images.append(ScrapedImage(
                        url=img_url, source_page=url, filename=filename,
                        is_thumbnail=img_data["is_thumbnail"],
                        fullres_url=img_data.get("fullres_url", ""),
                    ))
            else:
                self.image_urls.add(img_url)
                filename = os.path.basename(urlparse(img_url).path) or "image"
                self.images.append(ScrapedImage(
                    url=img_url, source_page=url, filename=filename,
                    is_thumbnail=img_data["is_thumbnail"],
                    fullres_url=img_data.get("fullres_url", ""),
                ))

        images_found = len(self.images) - images_before
        self.progress.image_count = len(self.images)
        await self._emit_progress()

        if node:
            node.status = "done"
            node.image_count = images_found

        self._log(f"✓ Scraped {url} — {images_found} images")

        # Extract links — always extract to show in graph/queue, even if not following
        page_links = self._extract_page_links(soup, url)
        parent_id = node.id if node else ""

        effective_depth = self.config.max_depth
        if not self.config.follow_links:
            effective_depth = 0
        elif self.config.exhaust_all:
            effective_depth = 9999  # practically unlimited

        for link in page_links:
            # Always add to graph for visualization
            child_node = self._add_crawl_node(link, depth + 1, parent_id=parent_id)

            # Add to queue if within depth and not visited
            if link not in self.visited_urls and link not in self._queued_set:
                if depth + 1 <= effective_depth:
                    if len(self.visited_urls) + self.queue.qsize() < self.config.max_pages:
                        await self.queue.put((link, depth + 1))
                        self._queued_set.add(link)
                        self.queue_urls.append({
                            "url": link, "depth": depth + 1, "status": "queued"
                        })
                        self.progress.queue_size = self.queue.qsize()

        if page_links:
            self._log(f"  Found {len(page_links)} links on page")

    async def run(self):
        self.progress.status = "running"
        self.progress.message = "Starting scrape…"
        await self._emit_progress()

        connector = aiohttp.TCPConnector(limit=self.config.max_concurrent)
        async with aiohttp.ClientSession(connector=connector) as session:
            await self._check_robots(session)

            start_url = self._normalize_url(self.config.start_url)
            self._add_crawl_node(start_url, 0)
            await self.queue.put((start_url, 0))
            self._queued_set.add(start_url)
            self.queue_urls.append({"url": start_url, "depth": 0, "status": "queued"})

            while not self.queue.empty() and not self._stop_flag:
                if len(self.visited_urls) >= self.config.max_pages:
                    self._log(f"⊘ Max pages limit reached ({self.config.max_pages})")
                    break

                url, depth = await self.queue.get()

                if url in self.visited_urls:
                    self.queue.task_done()
                    continue

                self.visited_urls.add(url)

                # Update queue tracking
                for q in self.queue_urls:
                    if q["url"] == url:
                        q["status"] = "processing"
                        break

                await self._process_url(session, url, depth)

                # Mark done in queue tracking
                for q in self.queue_urls:
                    if q["url"] == url:
                        q["status"] = "done"
                        break

                self.queue.task_done()
                self.progress.queue_size = self.queue.qsize()
                await self._emit_progress()

                if self.config.request_delay > 0 and not self.queue.empty() and not self._stop_flag:
                    await asyncio.sleep(self.config.request_delay)

        if self._stop_flag:
            self.progress.status = "cancelled"
            self.progress.message = "Scraping cancelled by user."
        else:
            self.progress.status = "done"
            self.progress.message = (
                f"Done! Found {len(self.images)} images "
                f"across {len(self.visited_urls)} pages."
            )
        self.progress.current_url = ""
        self.progress.queue_size = 0
        self._log(self.progress.message)
        await self._emit_progress()

    def stop(self):
        self._stop_flag = True

    async def download_images_zip(
        self,
        session: aiohttp.ClientSession,
        selected_urls: Optional[list[str]] = None,
        on_zip_progress: Optional[Callable] = None,
    ) -> io.BytesIO:
        buf = io.BytesIO()
        seen_filenames: dict[str, int] = {}

        # Filter images
        if selected_urls:
            imgs_to_download = [img for img in self.images if img.url in selected_urls]
        else:
            imgs_to_download = list(self.images)

        total = len(imgs_to_download)
        self.zip_progress = {"status": "zipping", "current": 0, "total": total, "filename": ""}

        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, img in enumerate(imgs_to_download):
                if self._stop_flag:
                    break
                try:
                    timeout = aiohttp.ClientTimeout(total=20)
                    async with session.get(
                        img.url, timeout=timeout, headers=DEFAULT_HEADERS, ssl=False,
                    ) as resp:
                        if resp.status != 200:
                            continue
                        data = await resp.read()

                        # Determine folder
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
                        self.zip_progress = {
                            "status": "zipping", "current": i + 1,
                            "total": total, "filename": fname
                        }
                        if on_zip_progress:
                            await on_zip_progress(self.zip_progress)
                except Exception:
                    continue

        self.zip_progress = {"status": "done", "current": total, "total": total, "filename": ""}
        buf.seek(0)
        return buf
