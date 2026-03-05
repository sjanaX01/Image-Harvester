# Shim — re-exports from the refactored app package.
# main.py now imports from routes.*, but legacy tooling that imports
# from this file directly will still work.
from app.scraper import ImageScraper
from app.models import ScrapeConfig, ScrapedImage, CrawlNode, ScrapeProgress
from app.constants import DEFAULT_HEADERS, IMAGE_EXTENSIONS
