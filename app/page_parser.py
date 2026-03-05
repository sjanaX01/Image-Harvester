import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from app.url_utils import normalize_url, is_image_url, is_same_domain, is_valid_page_url


def extract_raw_data(
    soup: BeautifulSoup,
    page_url: str,
    html: str,
    base_domain: str,
    status_code: int = 200,
    response_headers: dict = None,
) -> dict:
    """Extract structured raw data from a page for the Raw Data panel."""
    if response_headers is None:
        response_headers = {}

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    metas = []
    for m in soup.find_all("meta"):
        name = m.get("name") or m.get("property") or m.get("http-equiv") or ""
        content = m.get("content", "")
        if name:
            metas.append({"name": name, "content": content[:200]})

    all_links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href and not href.startswith(("#", "javascript:", "mailto:", "tel:")):
            full = urljoin(page_url, href)
            all_links.append({
                "text": a.get_text(strip=True)[:60],
                "href": full,
                "internal": is_same_domain(full, base_domain),
            })

    scripts = [s["src"] for s in soup.find_all("script", src=True)]
    styles = [s["href"] for s in soup.find_all("link", rel="stylesheet") if s.get("href")]
    img_tag_count = len(soup.find_all("img"))

    return {
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


def extract_image_urls(
    soup: BeautifulSoup,
    page_url: str,
    base_domain: str,
    detect_fullres: bool,
    same_domain_only: bool,
) -> list[dict]:
    """Extract image URLs. Returns list of {url, is_thumbnail, fullres_url}."""
    results = []
    seen_in_page: set[str] = set()

    def add_img(img_url: str, is_thumb: bool = False, fullres: str = ""):
        img_url = normalize_url(img_url)
        if img_url not in seen_in_page:
            seen_in_page.add(img_url)
            results.append({"url": img_url, "is_thumbnail": is_thumb, "fullres_url": fullres})

    for img in soup.find_all("img"):
        src = img.get("src")
        if not src:
            continue
        img_url = urljoin(page_url, src)

        fullres = ""
        parent_a = img.find_parent("a")
        if parent_a and parent_a.get("href"):
            a_href = urljoin(page_url, parent_a["href"])
            if is_image_url(a_href) and a_href != img_url:
                fullres = a_href

        is_thumb = bool(fullres)
        add_img(img_url, is_thumb=is_thumb, fullres=fullres)

        if fullres and detect_fullres:
            add_img(fullres, is_thumb=False, fullres="")

        srcset = img.get("srcset")
        if srcset:
            srcset_entries = []
            for entry in srcset.split(","):
                parts = entry.strip().split()
                if parts:
                    entry_url = urljoin(page_url, parts[0])
                    descriptor = parts[1] if len(parts) > 1 else "0w"
                    srcset_entries.append((entry_url, descriptor))

            if detect_fullres and srcset_entries:
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

        data_src = img.get("data-src")
        if data_src:
            add_img(urljoin(page_url, data_src))

        for attr in ("data-full", "data-original", "data-zoom-image",
                     "data-large", "data-hires", "data-full-src"):
            val = img.get(attr)
            if val:
                full_url = urljoin(page_url, val)
                if full_url != img_url:
                    if detect_fullres:
                        add_img(full_url, is_thumb=False, fullres="")
                        norm_img_url = normalize_url(img_url)
                        for r in results:
                            if r["url"] == norm_img_url:
                                r["is_thumbnail"] = True
                                r["fullres_url"] = full_url
                                break
                    else:
                        add_img(full_url)

    for source in soup.find_all("source"):
        srcset = source.get("srcset")
        if srcset:
            for entry in srcset.split(","):
                parts = entry.strip().split()
                if parts:
                    add_img(urljoin(page_url, parts[0]))

    for tag in soup.find_all(style=True):
        style = tag["style"]
        urls = re.findall(r'url\(["\']?(.*?)["\']?\)', style)
        for u in urls:
            full_url = urljoin(page_url, u)
            if is_image_url(full_url):
                add_img(full_url)

    for a in soup.find_all("a", href=True):
        href = urljoin(page_url, a["href"])
        if is_image_url(href):
            add_img(href)

    for meta in soup.find_all("meta", attrs={"property": "og:image"}):
        content = meta.get("content")
        if content:
            add_img(urljoin(page_url, content))

    return results


def extract_page_links(
    soup: BeautifulSoup,
    page_url: str,
    base_domain: str,
    same_domain_only: bool,
) -> list[str]:
    """Extract all crawlable page links from parsed HTML."""
    links = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        raw_href = a["href"].strip()
        if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        href = urljoin(page_url, raw_href)
        href = normalize_url(href)
        if href in seen:
            continue
        seen.add(href)
        if is_valid_page_url(href, base_domain, same_domain_only):
            links.append(href)
    return links
