from urllib.parse import urlparse, urljoin, urlunparse, unquote

from app.constants import IMAGE_EXTENSIONS

_SKIP_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".zip", ".rar", ".tar", ".gz",
    ".mp3", ".mp4", ".avi", ".mov", ".wmv",
    ".css", ".js", ".json", ".xml",
}


def normalize_url(url: str) -> str:
    """Strip fragment; remove trailing slash except for root paths."""
    parsed = urlparse(url)
    normalized = parsed._replace(fragment="")
    result = normalized.geturl()
    if result.endswith("/") and parsed.path != "/":
        result = result.rstrip("/")
    return result


def is_same_domain(url: str, base_domain: str) -> bool:
    target = urlparse(url).netloc.lower()
    return target == base_domain.lower()


def is_image_url(url: str) -> bool:
    path_lower = unquote(urlparse(url).path).lower()
    return any(path_lower.endswith(ext) for ext in IMAGE_EXTENSIONS)


def is_likely_image_url(url: str) -> bool:
    """Like is_image_url but also matches dynamic image endpoints."""
    if is_image_url(url):
        return True
    parsed = urlparse(url)
    q_lower = parsed.query.lower()
    path_lower = parsed.path.lower()
    image_hints = ("image", "img", "photo", "pic", "thumb", "media", "file")
    return any(h in path_lower or h in q_lower for h in image_hints)


def is_valid_page_url(url: str, base_domain: str, same_domain_only: bool) -> bool:
    """Return True if url should be queued for crawling as a page."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https", ""):
        return False
    if same_domain_only and not is_same_domain(url, base_domain):
        return False
    path_lower = parsed.path.lower()
    for ext in _SKIP_EXTENSIONS | IMAGE_EXTENSIONS:
        if path_lower.endswith(ext):
            return False
    return True


def matches_format_filter(url: str, allowed_formats: set) -> bool:
    """Return True if the image URL matches the allowed formats filter."""
    path_lower = unquote(urlparse(url).path).lower()
    for fmt in allowed_formats:
        fmt_clean = fmt.lower().strip(".")
        if path_lower.endswith(f".{fmt_clean}"):
            return True
    # If the URL doesn't have a known image extension, pass it through
    if not any(path_lower.endswith(ext) for ext in IMAGE_EXTENSIONS):
        return True
    return False
