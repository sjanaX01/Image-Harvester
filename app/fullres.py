"""Full-resolution image detection helpers."""

import re
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
from typing import Optional

import aiohttp


# Query params commonly used to request thumbnails.
THUMBNAIL_PARAMS = {
    "thumb", "thumbnail", "tn",
    "resize", "crop", "fit", "cover",
    "format", "auto",
}
# Params whose small numeric value indicates a thumbnail.
SIZE_PARAMS = {
    "w", "h", "width", "height", "size", "sz",
    "maxwidth", "maxheight", "max_width", "max_height",
    "tw", "th",
}
# Params that request reduced quality.
QUALITY_PARAMS = {"quality", "q", "ql"}


def generate_fullres_candidates(url: str) -> list[str]:
    """Generate candidate full-resolution URLs from a thumbnail URL."""
    candidates = []
    parsed = urlparse(url)
    params = parse_qs(parsed.query, keep_blank_values=True)
    path = parsed.path

    # Strategy 1: Strip thumbnail query params
    keys_lower = {k.lower(): k for k in params}
    thumb_keys_found = []
    for k, orig_k in keys_lower.items():
        if k in THUMBNAIL_PARAMS:
            thumb_keys_found.append(orig_k)
        elif k in SIZE_PARAMS:
            vals = params[orig_k]
            try:
                if vals and int(vals[0]) < 1200:
                    thumb_keys_found.append(orig_k)
            except (ValueError, IndexError):
                pass
        elif k in QUALITY_PARAMS:
            vals = params[orig_k]
            try:
                if vals and int(vals[0]) < 90:
                    thumb_keys_found.append(orig_k)
            except (ValueError, IndexError):
                pass

    if thumb_keys_found:
        clean_params = {k: v for k, v in params.items() if k not in thumb_keys_found}
        new_query = urlencode(clean_params, doseq=True)
        c = urlunparse(parsed._replace(query=new_query))
        if c != url:
            candidates.append(c)

        size_keys = [k for k in thumb_keys_found if keys_lower.get(k, "").lower() in SIZE_PARAMS]
        if size_keys and size_keys != thumb_keys_found:
            partial_params = {k: v for k, v in params.items() if k not in size_keys}
            new_query = urlencode(partial_params, doseq=True)
            c2 = urlunparse(parsed._replace(query=new_query))
            if c2 != url and c2 not in candidates:
                candidates.append(c2)

    # Strategy 2: Path directory patterns
    path_lower = path.lower()
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
            c_plain = urlunparse(parsed._replace(path=prefix + "/" + suffix))
            if c_plain != url and c_plain not in candidates:
                candidates.append(c_plain)
            break

    # Strategy 3: Filename suffix patterns
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

    # Strategy 4: WordPress -NNNxNNN pattern
    wp_match = re.sub(r'-\d{2,4}x\d{2,4}(\.[a-zA-Z]{3,4})$', r'\1', path)
    if wp_match != path:
        c = urlunparse(parsed._replace(path=wp_match))
        if c != url and c not in candidates:
            candidates.append(c)

    # Strategy 5: Cloudinary transform segments
    cloud_match = re.sub(
        r'/[a-z]_[a-z0-9_,]+(?:/[a-z]_[a-z0-9_,]+)*/',
        '/', path, count=1, flags=re.IGNORECASE
    )
    if cloud_match != path:
        c = urlunparse(parsed._replace(path=cloud_match))
        if c != url and c not in candidates:
            candidates.append(c)

    return candidates


async def probe_url(session: aiohttp.ClientSession, url: str) -> bool:
    """Return True if `url` resolves to an image (HTTP 200 + image content-type)."""
    try:
        timeout = aiohttp.ClientTimeout(total=6)
        async with session.head(url, timeout=timeout, ssl=False, allow_redirects=True) as resp:
            if resp.status == 200:
                ct = resp.headers.get("content-type", "").lower()
                return "image" in ct
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


async def resolve_fullres(session: aiohttp.ClientSession, url: str) -> Optional[str]:
    """Return the full-resolution URL for `url`, or None if not found."""
    for candidate in generate_fullres_candidates(url):
        if await probe_url(session, candidate):
            return candidate
    return None
