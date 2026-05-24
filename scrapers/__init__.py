"""DigiPin urban real-time scrapers.

Adapted from the Astro_Data scraper pattern (requests + BeautifulSoup,
polite delays, JSONL output, resume support) and generalised across
multiple sources. Each source lives in scrapers/sources/<name>.py and
follows the convention in scrapers/sources/__init__.py.
"""
