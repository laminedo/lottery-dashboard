#!/usr/bin/env python3
"""Download Washington Lotto draw history with exponential backoff and HTTP status code logging."""
import csv
import json
import random
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://www.lottery.net/washington/lotto/numbers/{}"
START_YEAR, END_YEAR = 1984, 2026
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
OUT_JSON = Path(__file__).resolve().parent / "walotto_history.json"
OUT_CSV = Path(__file__).resolve().parent / "walotto_history.csv"

MONTHS = {m: i + 1 for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"])}

ROW_RE = re.compile(
    r'<a href="/washington/lotto/numbers/[^"]+"[^>]*>\s*'
    r'(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*<br>\s*'
    r'(January|February|March|April|May|June|July|August|September|October|November|December)'
    r'\s+(\d{1,2}),\s+(\d{4})\s*</a>(.*?)</tr>',
    re.S)
BALL_RE = re.compile(r'<li class="ball">\s*(\d{1,2})\s*</li>')


def fetch_with_backoff(url, max_retries=3, initial_delay=1.0, backoff=2.0, timeout=30):
    """Fetch URL with exponential backoff and explicit HTTP status code logging."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
    last_err = None

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as http_err:
            last_err = http_err
            code = http_err.code
            reason = http_err.reason
            print(f"  [HTTP {code} {reason}] Attempt {attempt}/{max_retries} failed for {url}")
            if code in (403, 404):
                print(f"  -> Critical: HTTP {code} indicates access forbidden or invalid endpoint.")
                if code == 404:
                    return None
            elif code == 429:
                print("  -> Rate limited (429). Applying backoff...")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as net_err:
            last_err = net_err
            print(f"  [Network Error: {net_err}] Attempt {attempt}/{max_retries} for {url}")

        if attempt < max_retries:
            delay = initial_delay * (backoff ** (attempt - 1)) + random.uniform(0.1, 0.5)
            time.sleep(delay)

    raise last_err or RuntimeError(f"Failed to fetch {url}")


def main():
    draws = {}
    skipped = []
    for year in range(START_YEAR, END_YEAR + 1):
        url = BASE.format(year)
        try:
            html = fetch_with_backoff(url)
            if not html:
                continue
        except Exception as exc:
            print(f"{year}: FETCH FAILED ({exc})")
            continue
        count = 0
        for m in ROW_RE.finditer(html):
            _, month_name, day, y, row = m.groups()
            numbers = [int(n) for n in BALL_RE.findall(row)]
            if len(numbers) != 6 or len(set(numbers)) != 6 or not all(1 <= n <= 49 for n in numbers):
                skipped.append((y, month_name, day, numbers))
                continue
            date = f"{int(y):04d}-{MONTHS[month_name]:02d}-{int(day):02d}"
            draws[date] = sorted(numbers)
            count += 1
        print(f"{year}: {count} draws")
        if year < END_YEAR:
            time.sleep(0.5)

    if draws:
        records = [
            {"draw_date": date, "winning_numbers": " ".join(str(n) for n in draws[date])}
            for date in sorted(draws, reverse=True)
        ]
        OUT_JSON.write_text(json.dumps(records, indent=1) + "\n", encoding="utf-8")
        with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["draw_date", "ball1", "ball2", "ball3", "ball4", "ball5", "ball6"])
            for r in records:
                writer.writerow([r["draw_date"], *r["winning_numbers"].split()])
        print(f"\nSaved {len(records)} draws -> {OUT_JSON}")
        print(f"Range: {records[-1]['draw_date']} -> {records[0]['draw_date']}")
    else:
        print("No new draws retrieved (preserved existing local cache).")


if __name__ == "__main__":
    main()
