import asyncio
import hashlib
import io
import os
import re
import time
import zipfile
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse, urlunparse, unquote, parse_qs, urlencode
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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
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
    same_domain_only: bool = True


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

        # Raw data & crawl events
        self.raw_pages: dict[str, dict] = {}   # url -> page raw data
        self.crawl_events: list[dict] = []     # live categorized events

    def _log(self, msg: str):
        self.activity_log.append(msg)
        if len(self.activity_log) > 200:
            self.activity_log = self.activity_log[-150:]

    def _add_event(self, event_type: str, data: dict):
        """Add a categorized crawl event for the raw data live stream."""
        event = {"type": event_type, "ts": time.time(), **data}
        self.crawl_events.append(event)
        if len(self.crawl_events) > 2000:
            self.crawl_events = self.crawl_events[-1500:]

    def _extract_raw_data(self, soup: BeautifulSoup, page_url: str, html: str,
                          status_code: int = 200, response_headers: dict = None):
        """Extract structured raw data from a page for the Raw Data panel."""
        if response_headers is None:
            response_headers = {}

        # Title
        title_tag = soup.find("title")
        title = title_tag.get_text(strip=True) if title_tag else ""

        # Meta tags
        metas = []
        for m in soup.find_all("meta"):
            name = m.get("name") or m.get("property") or m.get("http-equiv") or ""
            content = m.get("content", "")
            if name:
                metas.append({"name": name, "content": content[:200]})

        # All links
        all_links = []
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if href and not href.startswith(("#", "javascript:", "mailto:", "tel:")):
                full = urljoin(page_url, href)
                all_links.append({
                    "text": a.get_text(strip=True)[:60],
                    "href": full,
                    "internal": self._is_same_domain(full),
                })

        # Scripts
        scripts = [s["src"] for s in soup.find_all("script", src=True)]

        # Stylesheets
        styles = [s["href"] for s in soup.find_all("link", rel="stylesheet") if s.get("href")]

        # Image tag count (raw, before filtering)
        img_tag_count = len(soup.find_all("img"))

        self.raw_pages[page_url] = {
            "url": page_url,
            "title": title,
            "status_code": status_code,
            "response_headers": response_headers,
            "meta_tags": metas[:30],
            "links": all_links[:150],
            "scripts": scripts[:30],
            "stylesheets": styles[:15],
            "img_tag_count": img_tag_count,
            "html_length": len(html),
            "html_snippet": html[:2000],
        }

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
        if self.config.same_domain_only and not self._is_same_domain(url):
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

    def _is_likely_image_url(self, url: str) -> bool:
        """Like _is_image_url but also matches dynamic image endpoints
        (URLs with image-related query params but no file extension)."""
        if self._is_image_url(url):
            return True
        parsed = urlparse(url)
        q_lower = parsed.query.lower()
        path_lower = parsed.path.lower()
        # Dynamic endpoints that serve images
        image_hints = ("image", "img", "photo", "pic", "thumb", "media", "file")
        if any(h in path_lower for h in image_hints):
            return True
        if any(h in q_lower for h in image_hints):
            return True
        return False

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

    # ── Full-Resolution Detection Engine ─────────────────────────────────

    # Query params commonly used to request thumbnails.
    # If ANY of these are present, the URL is likely a thumbnail.
    THUMBNAIL_PARAMS = {
        "thumb", "thumbnail", "tn",
        "resize", "crop", "fit", "cover",
        "format", "auto",
    }
    # Params whose small numeric value indicates a thumbnail.
    SIZE_PARAMS = {
        "w", "h", "width", "height", "size", "sz",
        "maxwidth", "maxheight", "max_width", "max_height",
        "tw", "th",  # thumb width/height
    }
    # Params that request reduced quality.
    QUALITY_PARAMS = {"quality", "q", "ql"}

    def _generate_fullres_candidates(self, url: str) -> list[str]:
        """Generate candidate full-resolution URLs from a thumbnail URL.
        Returns a list of candidate URLs sorted by likelihood (best first)."""
        candidates = []
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path

        # ── Strategy 1: Strip thumbnail query parameters ──────────────
        keys_lower = {k.lower(): k for k in params}
        thumb_keys_found = []

        for k, orig_k in keys_lower.items():
            if k in self.THUMBNAIL_PARAMS:
                thumb_keys_found.append(orig_k)
            elif k in self.SIZE_PARAMS:
                vals = params[orig_k]
                try:
                    if vals and int(vals[0]) < 1200:
                        thumb_keys_found.append(orig_k)
                except (ValueError, IndexError):
                    pass
            elif k in self.QUALITY_PARAMS:
                vals = params[orig_k]
                try:
                    if vals and int(vals[0]) < 90:
                        thumb_keys_found.append(orig_k)
                except (ValueError, IndexError):
                    pass

        if thumb_keys_found:
            # Candidate A: strip ALL thumbnail params
            clean_params = {k: v for k, v in params.items() if k not in thumb_keys_found}
            new_query = urlencode(clean_params, doseq=True)
            c = urlunparse(parsed._replace(query=new_query))
            if c != url:
                candidates.append(c)

            # Candidate B: only strip size params, keep the rest
            size_keys = [k for k in thumb_keys_found if keys_lower.get(k, "").lower() in self.SIZE_PARAMS]
            if size_keys and size_keys != thumb_keys_found:
                partial_params = {k: v for k, v in params.items() if k not in size_keys}
                new_query = urlencode(partial_params, doseq=True)
                c2 = urlunparse(parsed._replace(query=new_query))
                if c2 != url and c2 not in candidates:
                    candidates.append(c2)

        # ── Strategy 2: Path pattern rewriting ────────────────────────
        path_lower = path.lower()

        # /thumb/ → /full/ or /original/ or /large/
        thumb_dirs = ["/thumb/", "/thumbs/", "/thumbnails/", "/thumbnail/",
                      "/small/", "/sm/", "/mini/", "/preview/", "/cache/"]
        full_dirs = ["/full/", "/original/", "/originals/", "/large/", "/lg/", "/hires/"]

        for td in thumb_dirs:
            if td in path_lower:
                idx = path_lower.index(td)
                prefix = path[:idx]
                suffix = path[idx + len(td):]
                for fd in full_dirs:
                    c = urlunparse(parsed._replace(path=prefix + fd + suffix))
                    if c != url and c not in candidates:
                        candidates.append(c)
                # Also try just removing the thumb directory level
                c_plain = urlunparse(parsed._replace(path=prefix + "/" + suffix))
                if c_plain != url and c_plain not in candidates:
                    candidates.append(c_plain)
                break

        # _thumb.ext → .ext, _small.ext → .ext, _sm.ext → .ext
        suffix_patterns = [
            (r'_thumb(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'_small(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'_sm(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'_tn(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'_preview(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'_thumb(\.[a-zA-Z]{3,4})$', r'_full\1'),
            (r'_small(\.[a-zA-Z]{3,4})$', r'_large\1'),
            (r'-thumb(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'-small(\.[a-zA-Z]{3,4})$', r'\1'),
            (r'\.thumb(\.[a-zA-Z]{3,4})$', r'\1'),
        ]
        for pattern, repl in suffix_patterns:
            new_path = re.sub(pattern, repl, path, flags=re.IGNORECASE)
            if new_path != path:
                c = urlunparse(parsed._replace(path=new_path))
                if c != url and c not in candidates:
                    candidates.append(c)

        # WordPress: -NNNxNNN.ext → .ext
        wp_match = re.sub(r'-\d{2,4}x\d{2,4}(\.[a-zA-Z]{3,4})$', r'\1', path)
        if wp_match != path:
            c = urlunparse(parsed._replace(path=wp_match))
            if c != url and c not in candidates:
                candidates.append(c)

        # Cloudinary: /c_thumb,w_200,h_200/ → remove transform segment
        cloud_match = re.sub(
            r'/[a-z]_[a-z0-9_,]+(?:/[a-z]_[a-z0-9_,]+)*/',
            '/', path, count=1, flags=re.IGNORECASE
        )
        if cloud_match != path:
            c = urlunparse(parsed._replace(path=cloud_match))
            if c != url and c not in candidates:
                candidates.append(c)

        return candidates

    async def _probe_url(self, session: aiohttp.ClientSession, url: str) -> bool:
        """Check if a URL returns a valid image (HTTP 200 with image content-type)."""
        try:
            timeout = aiohttp.ClientTimeout(total=6)
            async with session.head(
                url, timeout=timeout,
                ssl=False, allow_redirects=True,
            ) as resp:
                if resp.status == 200:
                    ct = resp.headers.get("content-type", "").lower()
                    return "image" in ct
                # Some servers don't support HEAD; try a range GET
                if resp.status in (405, 403):
                    async with session.get(
                        url, timeout=timeout,
                        headers={"Range": "bytes=0-0"},
                        ssl=False, allow_redirects=True,
                    ) as resp2:
                        ct = resp2.headers.get("content-type", "").lower()
                        return resp2.status in (200, 206) and "image" in ct
        except Exception:
            pass
        return False

    async def _resolve_fullres(self, session: aiohttp.ClientSession, url: str) -> str | None:
        """Try to find a full-resolution version of the image at `url`.
        Returns the full-res URL if found, else None."""
        candidates = self._generate_fullres_candidates(url)
        for candidate in candidates:
            if await self._probe_url(session, candidate):
                self._log(f"  ⬆ Full-res found: {candidate}")
                return candidate
        return None

    # ── End Full-Resolution Detection ─────────────────────────────────

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

            # If detect_fullres and there's a known full-res, add it directly too
            if fullres and self.config.detect_fullres:
                add_img(fullres, is_thumb=False, fullres="")

            # srcset — pick the largest descriptor as potential full-res
            srcset = img.get("srcset")
            if srcset:
                srcset_entries = []
                for entry in srcset.split(","):
                    parts = entry.strip().split()
                    if parts:
                        entry_url = urljoin(page_url, parts[0])
                        descriptor = parts[1] if len(parts) > 1 else "0w"
                        srcset_entries.append((entry_url, descriptor))

                if self.config.detect_fullres and srcset_entries:
                    # Pick the largest srcset entry as the full-res
                    def _desc_value(desc):
                        try:
                            return int(desc.replace("w", "").replace("x", ""))
                        except ValueError:
                            return 0
                    srcset_entries.sort(key=lambda x: _desc_value(x[1]), reverse=True)
                    best = srcset_entries[0][0]
                    if best != img_url:
                        add_img(best, is_thumb=False, fullres="")
                else:
                    for entry_url, _ in srcset_entries:
                        add_img(entry_url)

            # data-src (lazy loading)
            data_src = img.get("data-src")
            if data_src:
                add_img(urljoin(page_url, data_src))

            # data-full, data-original, data-zoom-image (common full-res attributes)
            for attr in ("data-full", "data-original", "data-zoom-image",
                         "data-large", "data-hires", "data-full-src"):
                val = img.get(attr)
                if val:
                    full_url = urljoin(page_url, val)
                    if full_url != img_url:
                        if self.config.detect_fullres:
                            add_img(full_url, is_thumb=False, fullres="")
                            # Mark the original as thumbnail if we found a better one
                            for r in results:
                                if r["url"] == self._normalize_url(img_url):
                                    r["is_thumbnail"] = True
                                    r["fullres_url"] = full_url
                                    break
                        else:
                            add_img(full_url)

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
    ) -> dict:
        """Fetch a page. Returns dict with keys: html, status, headers, error."""
        result = {"html": None, "status": 0, "headers": {}, "error": ""}
        try:
            timeout = aiohttp.ClientTimeout(total=self.config.request_timeout)
            async with session.get(
                url, timeout=timeout, ssl=False,
                allow_redirects=True,
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
                return result
        except asyncio.TimeoutError:
            result["error"] = "Timeout"
            return result
        except Exception as e:
            result["error"] = str(e)[:120]
            return result

    async def _get_image_info(
        self, session: aiohttp.ClientSession, url: str
    ) -> Optional[tuple[int, str]]:
        try:
            timeout = aiohttp.ClientTimeout(total=8)
            async with session.head(
                url, timeout=timeout, ssl=False
            ) as resp:
                if resp.status == 200:
                    size = int(resp.headers.get("content-length", 0))
                    ct = resp.headers.get("content-type", "")
                    return size, ct
                async with session.get(
                    url, timeout=timeout,
                    headers={"Range": "bytes=0-0"},
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

        self._log(f"\u2192 Fetching: {url}")
        fetch_result = await self._fetch_page(session, url)
        resp_status = fetch_result["status"]
        resp_headers = fetch_result["headers"]
        html = fetch_result["html"]

        if html is None:
            err_reason = fetch_result["error"] or "Unknown error"
            self._log(f"\u2717 Failed to fetch: {url} \u2014 {err_reason}")
            if node:
                node.status = "error"
            # Record raw data even for failures so the Raw Data tab shows something
            self.raw_pages[url] = {
                "url": url,
                "title": "",
                "status_code": resp_status,
                "error": err_reason,
                "response_headers": resp_headers,
                "meta_tags": [], "links": [], "scripts": [],
                "stylesheets": [], "img_tag_count": 0,
                "html_length": 0, "html_snippet": "",
            }
            self._add_event("error", {
                "url": url, "depth": depth,
                "status": resp_status,
                "reason": err_reason,
            })
            return

        soup = BeautifulSoup(html, "lxml")

        # Extract raw page data (includes response headers now)
        self._extract_raw_data(soup, url, html, resp_status, resp_headers)

        # Extract images
        images_before = len(self.images)
        raw_images = self._extract_image_urls(soup, url)

        self._add_event("page_start", {
            "url": url, "depth": depth,
            "title": self.raw_pages.get(url, {}).get("title", ""),
        })

        for img_data in raw_images:
            img_url = img_data["url"]
            if img_url in self.image_urls:
                continue
            if not self._matches_format_filter(img_url):
                continue
            # Filter images by domain when same_domain_only is enabled
            if self.config.same_domain_only and not self._is_same_domain(img_url):
                continue

            is_thumb = img_data["is_thumbnail"]
            fullres_url = img_data.get("fullres_url", "")

            # Filter fullres URL by domain too
            if fullres_url and self.config.same_domain_only and not self._is_same_domain(fullres_url):
                fullres_url = ""
                is_thumb = False

            # ── Smart Full-Res Resolution ──
            # When detect_fullres is ON and this image hasn't already been
            # identified as a full-res image, try to find its full-res version.
            if self.config.detect_fullres and not fullres_url and not is_thumb:
                resolved = await self._resolve_fullres(session, img_url)
                if resolved and resolved != img_url and resolved not in self.image_urls:
                    # Skip if full-res is on a different domain and domain lock is on
                    if self.config.same_domain_only and not self._is_same_domain(resolved):
                        resolved = None
                if resolved and resolved != img_url and resolved not in self.image_urls:
                    # Mark this image as a thumbnail, add the resolved full-res
                    is_thumb = True
                    fullres_url = resolved

                    # Add the full-res image directly
                    self.image_urls.add(resolved)
                    fr_filename = os.path.basename(urlparse(resolved).path) or "image"
                    fr_size, fr_ct = 0, ""
                    info = await self._get_image_info(session, resolved)
                    if info:
                        fr_size, fr_ct = info
                    self.images.append(ScrapedImage(
                        url=resolved, source_page=url,
                        file_size=fr_size, content_type=fr_ct,
                        filename=fr_filename,
                        is_thumbnail=False, fullres_url="",
                    ))

            # Get file size if filter requires it
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
                filename=filename,
                is_thumbnail=is_thumb,
                fullres_url=fullres_url,
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
            new_queued = sum(1 for q in self.queue_urls if q["status"] == "queued")
            self._log(f"  Found {len(page_links)} links on page")
            self._add_event("links_found", {
                "url": url, "count": len(page_links),
                "queued": new_queued,
                "links": [l for l in page_links[:20]],
            })

    async def run(self):
        self.progress.status = "running"
        self.progress.message = "Starting scrape…"
        await self._emit_progress()

        connector = aiohttp.TCPConnector(limit=self.config.max_concurrent)
        async with aiohttp.ClientSession(
            connector=connector, headers=DEFAULT_HEADERS
        ) as session:
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
                        img.url, timeout=timeout, ssl=False,
                    ) as resp:
                        if not (200 <= resp.status < 300):
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
