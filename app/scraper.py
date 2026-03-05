"""ImageScraper — async BFS web crawler and image harvester."""

import asyncio
import os
import time
from typing import Callable, Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import aiohttp
from bs4 import BeautifulSoup

from app.constants import DEFAULT_HEADERS
from app.models import ScrapedImage, ScrapeConfig, CrawlNode, ScrapeProgress
from app.url_utils import normalize_url, is_same_domain, is_image_url, matches_format_filter
from app.page_parser import extract_raw_data, extract_image_urls, extract_page_links
from app.fullres import resolve_fullres
from app.downloader import download_images_zip as _zip_builder


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

        # Raw data & crawl events
        self.raw_pages: dict[str, dict] = {}
        self.crawl_events: list[dict] = []

    # ── Logging & Events ──────────────────────────────────────────────────────

    def _log(self, msg: str):
        self.activity_log.append(msg)
        if len(self.activity_log) > 200:
            self.activity_log = self.activity_log[-150:]

    def _add_event(self, event_type: str, data: dict):
        event = {"type": event_type, "ts": time.time(), **data}
        self.crawl_events.append(event)
        if len(self.crawl_events) > 2000:
            self.crawl_events = self.crawl_events[-1500:]

    async def _emit_progress(self):
        if self.on_progress:
            await self.on_progress(self.progress)

    # ── Graph Helpers ─────────────────────────────────────────────────────────

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

    # ── Robots.txt ────────────────────────────────────────────────────────────

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
        ua = DEFAULT_HEADERS.get("User-Agent", "*")
        return self._robots_parser.can_fetch(ua, url)

    # ── Page Fetching ─────────────────────────────────────────────────────────

    async def _fetch_page(
        self, session: aiohttp.ClientSession, url: str
    ) -> dict:
        result = {"html": None, "status": 0, "headers": {}, "error": ""}
        try:
            timeout = aiohttp.ClientTimeout(total=self.config.request_timeout)
            async with session.get(
                url, timeout=timeout, ssl=False, allow_redirects=True
            ) as resp:
                result["status"] = resp.status
                result["headers"] = dict(resp.headers)
                if resp.status != 200:
                    result["error"] = f"HTTP {resp.status}"
                    return result
                content_type = resp.headers.get("content-type", "")
                if "text/html" not in content_type and "application/xhtml" not in content_type:
                    result["error"] = f"Not HTML: {content_type}"
                    return result
                result["html"] = await resp.text(errors="replace")
        except asyncio.TimeoutError:
            result["error"] = "Timeout"
        except Exception as e:
            result["error"] = str(e)[:120]
        return result

    async def _get_image_info(
        self, session: aiohttp.ClientSession, url: str
    ) -> Optional[tuple[int, str]]:
        try:
            timeout = aiohttp.ClientTimeout(total=8)
            async with session.head(url, timeout=timeout, ssl=False) as resp:
                if resp.status == 200:
                    size = int(resp.headers.get("content-length", 0))
                    ct = resp.headers.get("content-type", "")
                    return size, ct
                async with session.get(
                    url, timeout=timeout,
                    headers={"Range": "bytes=0-0"}, ssl=False
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

    # ── Core Crawl Step ───────────────────────────────────────────────────────

    async def _process_url(
        self, session: aiohttp.ClientSession, url: str, depth: int
    ):
        if self._stop_flag:
            return

        if not self._can_fetch(url):
            self._log(f"✗ Blocked by robots.txt: {url}")
            return

        node = self._node_map.get(url)
        if node:
            node.status = "scraping"

        self.progress.current_url = url
        self.progress.queue_size = self.queue.qsize()
        self.progress.visited_count = len(self.visited_urls)
        self.progress.message = f"Scraping: {url}"
        await self._emit_progress()

        self._log(f"→ Fetching: {url}")
        fetch_result = await self._fetch_page(session, url)
        resp_status = fetch_result["status"]
        resp_headers = fetch_result["headers"]
        html = fetch_result["html"]

        if html is None:
            err_reason = fetch_result["error"] or "Unknown error"
            self._log(f"✗ Failed to fetch: {url} — {err_reason}")
            if node:
                node.status = "error"
            self.raw_pages[url] = {
                "url": url, "title": "", "status_code": resp_status,
                "error": err_reason, "response_headers": resp_headers,
                "meta_tags": [], "links": [], "scripts": [],
                "stylesheets": [], "img_tag_count": 0,
                "html_length": 0, "html_snippet": "",
            }
            self._add_event("error", {
                "url": url, "depth": depth,
                "status": resp_status, "reason": err_reason,
            })
            return

        soup = BeautifulSoup(html, "lxml")
        self.raw_pages[url] = extract_raw_data(
            soup, url, html, self.base_domain, resp_status, resp_headers
        )

        images_before = len(self.images)
        raw_images = extract_image_urls(
            soup, url, self.base_domain,
            self.config.detect_fullres, self.config.same_domain_only
        )

        self._add_event("page_start", {
            "url": url, "depth": depth,
            "title": self.raw_pages.get(url, {}).get("title", ""),
        })

        for img_data in raw_images:
            img_url = img_data["url"]
            if img_url in self.image_urls:
                continue
            if not matches_format_filter(img_url, self.config.allowed_formats):
                continue
            if self.config.same_domain_only and not is_same_domain(img_url, self.base_domain):
                continue

            is_thumb = img_data["is_thumbnail"]
            fullres_url = img_data.get("fullres_url", "")

            if fullres_url and self.config.same_domain_only and not is_same_domain(fullres_url, self.base_domain):
                fullres_url = ""
                is_thumb = False

            if self.config.detect_fullres and not fullres_url and not is_thumb:
                resolved = await resolve_fullres(session, img_url)
                if resolved and resolved != img_url and resolved not in self.image_urls:
                    if self.config.same_domain_only and not is_same_domain(resolved, self.base_domain):
                        resolved = None
                if resolved and resolved != img_url and resolved not in self.image_urls:
                    is_thumb = True
                    fullres_url = resolved
                    self.image_urls.add(resolved)
                    fr_filename = os.path.basename(urlparse(resolved).path) or "image"
                    fr_size, fr_ct = 0, ""
                    info = await self._get_image_info(session, resolved)
                    if info:
                        fr_size, fr_ct = info
                    self.images.append(ScrapedImage(
                        url=resolved, source_page=url,
                        file_size=fr_size, content_type=fr_ct,
                        filename=fr_filename, is_thumbnail=False, fullres_url="",
                    ))

            file_size, content_type = 0, ""
            if self.config.min_file_size > 0:
                info = await self._get_image_info(session, img_url)
                if info:
                    file_size, content_type = info
                    if file_size > 0 and file_size < self.config.min_file_size:
                        continue

            self.image_urls.add(img_url)
            filename = os.path.basename(urlparse(img_url).path) or "image"
            self.images.append(ScrapedImage(
                url=img_url, source_page=url,
                file_size=file_size, content_type=content_type,
                filename=filename, is_thumbnail=is_thumb, fullres_url=fullres_url,
            ))

        images_found = len(self.images) - images_before
        self.progress.image_count = len(self.images)
        await self._emit_progress()

        if node:
            node.status = "done"
            node.image_count = images_found

        self._log(f"✓ Scraped {url} — {images_found} images")
        self._add_event("page_done", {
            "url": url, "depth": depth,
            "images_found": images_found,
            "total_images": len(self.images),
        })

        page_links = extract_page_links(
            soup, url, self.base_domain, self.config.same_domain_only
        )
        parent_id = node.id if node else ""

        effective_depth = self.config.max_depth
        if not self.config.follow_links:
            effective_depth = 0
        elif self.config.exhaust_all:
            effective_depth = 9999

        for link in page_links:
            child_node = self._add_crawl_node(link, depth + 1, parent_id=parent_id)
            if link not in self.visited_urls and link not in self._queued_set:
                if depth + 1 <= effective_depth:
                    if len(self.visited_urls) + self.queue.qsize() < self.config.max_pages:
                        await self.queue.put((link, depth + 1))
                        self._queued_set.add(link)
                        self.queue_urls.append({"url": link, "depth": depth + 1, "status": "queued"})
                        self.progress.queue_size = self.queue.qsize()

        if page_links:
            new_queued = sum(1 for q in self.queue_urls if q["status"] == "queued")
            self._log(f"  Found {len(page_links)} links on page")
            self._add_event("links_found", {
                "url": url, "count": len(page_links),
                "queued": new_queued,
                "links": page_links[:20],
            })

    # ── Main Run Loop ─────────────────────────────────────────────────────────

    async def run(self):
        self.progress.status = "running"
        self.progress.message = "Starting scrape…"
        await self._emit_progress()

        connector = aiohttp.TCPConnector(limit=self.config.max_concurrent)
        async with aiohttp.ClientSession(
            connector=connector, headers=DEFAULT_HEADERS
        ) as session:
            await self._check_robots(session)
            start_url = normalize_url(self.config.start_url)
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
                for q in self.queue_urls:
                    if q["url"] == url:
                        q["status"] = "processing"
                        break

                await self._process_url(session, url, depth)

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
        selected_urls: Optional[list[str]] = None,
        on_zip_progress: Optional[Callable] = None,
    ):
        """Thin wrapper around the standalone download_images_zip function."""
        self.zip_progress = {"status": "zipping", "current": 0, "total": len(self.images), "filename": ""}
        buf = await _zip_builder(
            images=self.images,
            selected_urls=selected_urls,
            stop_flag_fn=lambda: self._stop_flag,
            on_progress=on_zip_progress,
        )
        self.zip_progress = {"status": "done", "current": len(self.images), "total": len(self.images), "filename": ""}
        return buf
