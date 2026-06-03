#!/usr/bin/env python3
"""
nyt_import.py — build a "what was actually printed" import file for The Archive register.

It asks the New York Times Archive API for a month of article METADATA, keeps only
the pieces that ran in the print edition (those have a `print_page`), groups them by
day, and writes a JSON file shaped exactly like the register's own export — so you can
drop it into the app with the Import button.

What it stores: headline, byline, section, print page, the NYT-provided abstract, and
the canonical nytimes.com link. It does NOT store full article text (that's paywalled
and copyrighted) — you click the link to read, signed in as a subscriber.

------------------------------------------------------------------------------------
SETUP (one time)
  1. Make a free developer account + key: https://developer.nytimes.com/  ->  My Apps
     -> enable the "Archive API". Copy the key.
  2. pip install requests

USAGE
  python nyt_import.py 2026-01-15                 # a single day
  python nyt_import.py 2026-01-01 2026-01-31      # an inclusive date range
  # key via flag or environment variable:
  python nyt_import.py 2026-01-15 --api-key YOUR_KEY
  export NYT_API_KEY=YOUR_KEY  &&  python nyt_import.py 2026-01-15

Then in the app: Import -> pick the generated  archive-import-*.json  file.
Importing merges by entry id, so re-running a day updates it rather than duplicating.
------------------------------------------------------------------------------------
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import uuid

try:
    import requests
except ImportError:
    sys.exit("This script needs the 'requests' package.  Run:  pip install requests")

ARCHIVE_URL = "https://api.nytimes.com/svc/archive/v1/{year}/{month}.json"


def parse_date(s):
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        sys.exit(f"Bad date '{s}'. Use YYYY-MM-DD, e.g. 2026-01-15.")


def months_between(start, end):
    """Yield (year, month) tuples covering the start..end range."""
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m, y = 1, y + 1


def fetch_month(year, month, api_key):
    url = ARCHIVE_URL.format(year=year, month=month)
    r = requests.get(url, params={"api-key": api_key}, timeout=60)
    if r.status_code == 401:
        sys.exit("401 Unauthorized — check your API key and that the Archive API is enabled for your app.")
    if r.status_code == 429:
        sys.exit("429 Too Many Requests — you've hit the daily/per-minute rate limit. Try again later.")
    r.raise_for_status()
    return r.json().get("response", {}).get("docs", [])


def first(*vals):
    for v in vals:
        if v:
            return v
    return ""


def to_article(doc):
    """Map one NYT API doc to the register's article shape."""
    headline = doc.get("headline") or {}
    byline = (doc.get("byline") or {}).get("original") or ""
    abstract = first(doc.get("abstract"), doc.get("snippet"), doc.get("lead_paragraph"))
    note = abstract
    if byline:
        note = f"{byline.strip()} — {abstract}".strip(" —") if abstract else byline.strip()
    return {
        "id": str(uuid.uuid4()),
        "title": first(headline.get("print_headline"), headline.get("main"), "(untitled)"),
        "section": first(doc.get("print_section"), doc.get("section_name"), doc.get("news_desk")),
        "page": str(doc.get("print_page") or "").strip(),
        "note": note,
        "url": doc.get("web_url", ""),
        "tags": [],
        "clip": False,
    }


def main():
    ap = argparse.ArgumentParser(description="Build a NYT print-edition import file for The Archive register.")
    ap.add_argument("start", help="date YYYY-MM-DD (single day, or start of range)")
    ap.add_argument("end", nargs="?", help="optional end date YYYY-MM-DD (inclusive)")
    ap.add_argument("--api-key", default=os.environ.get("NYT_API_KEY"), help="NYT API key (or set NYT_API_KEY)")
    ap.add_argument("--out", help="output filename (default archive-import-<range>.json)")
    args = ap.parse_args()

    if not args.api_key:
        sys.exit("No API key. Pass --api-key or set the NYT_API_KEY environment variable.")

    start = parse_date(args.start)
    end = parse_date(args.end) if args.end else start
    if end < start:
        start, end = end, start

    # gather docs across the months the range touches
    by_date = {}            # 'YYYY-MM-DD' -> list of articles
    seen_urls = set()
    for i, (year, month) in enumerate(months_between(start, end)):
        if i:
            time.sleep(13)  # stay under 5 requests/minute
        print(f"  fetching {year}-{month:02d} ...", file=sys.stderr)
        for doc in fetch_month(year, month, args.api_key):
            # print edition only: must have a print_page
            if not str(doc.get("print_page") or "").strip():
                continue
            pub = (doc.get("pub_date") or "")[:10]
            try:
                d = dt.date.fromisoformat(pub)
            except ValueError:
                continue
            if not (start <= d <= end):
                continue
            url = doc.get("web_url", "")
            if url and url in seen_urls:
                continue
            seen_urls.add(url)
            by_date.setdefault(pub, []).append(to_article(doc))

    if not by_date:
        sys.exit("No print articles found for that date range. (Very recent dates can lag in the Archive API.)")

    now_ms = int(time.time() * 1000)
    entries = []
    for date in sorted(by_date, reverse=True):
        arts = by_date[date]
        # stable id per date so re-imports update rather than duplicate,
        # and so it merges with days seeded inside the app
        entries.append({
            "id": f"nyt-{date}",
            "date": date,
            "box": "",
            "headline": "",
            "note": "",
            "tags": [],
            "articles": arts,
            "updatedAt": now_ms,
            "source": "nyt",
            "publication": "The New York Times",
            "issueLabel": "",
        })

    out = args.out or (
        f"archive-import-{start.isoformat()}.json" if start == end
        else f"archive-import-{start.isoformat()}_to_{end.isoformat()}.json"
    )
    with open(out, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)

    total = sum(len(e["articles"]) for e in entries)
    print(f"Wrote {out}: {len(entries)} day(s), {total} print articles.")
    print("Now open the register and use Import to load it.")


if __name__ == "__main__":
    main()
