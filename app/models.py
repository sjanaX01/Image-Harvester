from dataclasses import dataclass, field


@dataclass
class ScrapedImage:
    url: str
    source_page: str
    file_size: int = 0
    content_type: str = ""
    filename: str = ""
    is_thumbnail: bool = False
    fullres_url: str = ""


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
    status: str = "pending"   # pending | scraping | done | error
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
