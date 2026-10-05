#!/usr/bin/env python3
"""
Automated 24-Hour Lottery Synchronization Cron & Pipeline

Fetches latest official lottery draw results for all active games:
  - Mega Millions (NY Open Data Socrata API)
  - Powerball (NY Open Data Socrata API)
  - Hit 5 (WA Lottery Official Feed)
  - Washington Lotto (WA Lottery Official Feed)

Standardizes historical records strictly into the unified schema:
  {
    "draw_date": "YYYY-MM-DD",
    "winning_numbers": [3, 15, 24, 38, 62],
    "bonus_numbers": [14],
    "jackpot_amount": "$450,000,000"
  }

Validates and deduplicates against the database before saving.
Can be executed as a one-shot job or as a recurring 24-hour daemon (--cron).
"""

import csv
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

HERE = Path(__file__).parent.resolve()
WHITE_PICK = 5  # white balls per draw for the Socrata games (Mega Millions, Powerball)
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"

ACTIVE_GAMES = {
    "mega": {
        "label": "Mega Millions",
        "api_url": "https://data.ny.gov/resource/5xaw-6ayf.json?$limit=5000&$order=draw_date%20DESC",
        "has_bonus": True,
        "json_file": "mega_history.json",
        "csv_file": "mega_history.csv"
    },
    "powerball": {
        "label": "Powerball",
        "api_url": "https://data.ny.gov/resource/d6yy-54nr.json?$limit=5000&$order=draw_date%20DESC",
        "has_bonus": True,
        "json_file": "powerball_history.json",
        "csv_file": "powerball_history.csv"
    },
    "hit5": {
        "label": "Hit 5",
        "wa_name": "hit5",
        "has_bonus": False,
        "json_file": "hit5_history.json",
        "csv_file": "hit5_history.csv"
    },
    "walotto": {
        "label": "Washington Lotto",
        "wa_name": "lotto",
        "has_bonus": False,
        "json_file": "walotto_history.json",
        "csv_file": "walotto_history.csv"
    }
}


def fetch_url(url, timeout=20):
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json, text/html, */*"})
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def normalize_record(raw, has_bonus=True):
    """Normalize any record dictionary into standard schema."""
    if not isinstance(raw, dict):
        return None

    # 1. draw_date
    date_val = str(raw.get("draw_date") or raw.get("drawDate") or raw.get("date") or "").strip()
    if not date_val:
        return None
    draw_date = date_val[:10]
    if len(draw_date) != 10 or draw_date[4] != "-" or draw_date[7] != "-":
        return None

    # 2. winning_numbers
    winning = raw.get("winning_numbers") or raw.get("numbers") or []
    if isinstance(winning, str):
        winning = [int(x) for x in re.findall(r"\d+", winning)]
    elif isinstance(winning, list):
        winning = [int(x) for x in winning if str(x).isdigit()]
    winning = sorted(winning)

    # 3. bonus_numbers
    bonus = raw.get("bonus_numbers")
    if bonus is None:
        bonus_val = raw.get("mega_ball") or raw.get("megaBall") or raw.get("bonus")
        if bonus_val is not None and str(bonus_val).strip() != "":
            bonus = [int(bonus_val)]
        else:
            bonus = []
    elif isinstance(bonus, list):
        bonus = [int(x) for x in bonus if str(x).isdigit()]
    elif isinstance(bonus, (int, str)) and str(bonus).isdigit():
        bonus = [int(bonus)]
    else:
        bonus = []

    if not has_bonus:
        bonus = []

    # 4. jackpot_amount
    jackpot = str(raw.get("jackpot_amount") or raw.get("jackpot") or raw.get("estimated_jackpot") or "N/A")

    return {
        "draw_date": draw_date,
        "winning_numbers": winning,
        "bonus_numbers": bonus,
        "jackpot_amount": jackpot
    }


def load_existing_db(json_file):
    path = HERE / json_file
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list):
                result = {}
                for item in data:
                    norm = normalize_record(item)
                    if norm:
                        result[norm["draw_date"]] = norm
                return result
    except Exception:
        pass
    return {}


def sync_socrata_game(game_id, cfg):
    """Sync Mega Millions or Powerball via NY Open Data Socrata API."""
    existing = load_existing_db(cfg["json_file"])
    added = 0
    updated = 0

    try:
        raw_text = fetch_url(cfg["api_url"])
        items = json.loads(raw_text)
        for item in items:
            date_str = (item.get("draw_date") or "")[:10]
            winning_str = item.get("winning_numbers") or ""
            mega_str = item.get("mega_ball") or ""
            multiplier = item.get("multiplier") or ""

            if not date_str or not winning_str:
                continue

            winning_nums = [int(x) for x in winning_str.strip().split() if x.isdigit()]
            bonus_nums = [int(mega_str)] if mega_str.isdigit() else []
            # Powerball rows carry the Powerball as the 6th winning number (no separate field).
            if not bonus_nums and len(winning_nums) == WHITE_PICK + 1:
                bonus_nums = [winning_nums.pop()]
            jackpot_amount = item.get("jackpot_amount") or item.get("estimated_jackpot") or "N/A"

            norm = {
                "draw_date": date_str,
                "winning_numbers": sorted(winning_nums),
                "bonus_numbers": bonus_nums,
                "jackpot_amount": str(jackpot_amount)
            }

            if date_str not in existing:
                existing[date_str] = norm
                added += 1
            else:
                # Update if new fields populated
                existing[date_str] = norm
                updated += 1

    except Exception as exc:
        print(f"[{game_id}] API fetch warning: {exc}")

    # Sort all draws descending
    sorted_draws = sorted(existing.values(), key=lambda x: x["draw_date"], reverse=True)
    save_game_db(cfg, sorted_draws)
    return {"game": game_id, "total": len(sorted_draws), "added": added, "ok": True}


def parse_wa_official_html(html, has_bonus=False):
    """Parse Washington State Lottery past drawings HTML tables."""
    results = []
    # Each drawing is a table headed by <p class="h2-like">Sat, Oct 03, 2026</p>
    # followed by <td class="game-balls"><ul><li>07</li>...</ul>.
    pattern = re.compile(
        r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{4})\s*</p>"
        r"[\s\S]{0,2000}?game-balls[\s\S]{0,200}?<ul>([\s\S]{0,4000}?)</ul>"
    )
    seen = set()
    for mon, day, year, block in pattern.findall(html):
        month = MONTHS.get(mon.lower())
        if not month:
            continue
        draw_date = f"{int(year):04d}-{month:02d}-{int(day):02d}"
        if draw_date in seen:  # the page repeats each drawing for its small-viewport layout
            continue
        nums = [int(x) for x in re.findall(r"<li>\s*(\d{1,2})\s*</li>", block)]
        if not nums:
            continue
        seen.add(draw_date)
        results.append({
            "draw_date": draw_date,
            "winning_numbers": sorted(nums),
            "bonus_numbers": [],
            "jackpot_amount": "N/A"
        })
    return results


def sync_wa_game(game_id, cfg):
    """Sync Washington State games (Hit 5 / WA Lotto)."""
    existing = load_existing_db(cfg["json_file"])
    added = 0

    url = f"https://walottery.com/winningnumbers/pastdrawings.aspx?gamename={cfg['wa_name']}&unittype=day&unitcount=180"
    try:
        html = fetch_url(url)
        draws = parse_wa_official_html(html, cfg["has_bonus"])
        for d in draws:
            date_str = d["draw_date"]
            if date_str not in existing:
                existing[date_str] = d
                added += 1
    except Exception as exc:
        print(f"[{game_id}] WA official fetch notice: {exc}")

    sorted_draws = sorted(existing.values(), key=lambda x: x["draw_date"], reverse=True)
    save_game_db(cfg, sorted_draws)
    return {"game": game_id, "total": len(sorted_draws), "added": added, "ok": True}


def save_game_db(cfg, sorted_draws):
    """Save standardized draws to JSON and CSV database files."""
    json_path = HERE / cfg["json_file"]
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(sorted_draws, f, indent=1)

    csv_path = HERE / cfg["csv_file"]
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["draw_date", "winning_numbers", "bonus_numbers", "jackpot_amount"])
        for d in sorted_draws:
            writer.writerow([
                d["draw_date"],
                " ".join(map(str, d["winning_numbers"])),
                " ".join(map(str, d["bonus_numbers"])),
                d["jackpot_amount"]
            ])


def update_metadata(results):
    """Update centralized sync metadata."""
    meta = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "syncStatus": "active",
        "games": {}
    }
    for res in results:
        g = res["game"]
        cfg = ACTIVE_GAMES[g]
        existing = load_existing_db(cfg["json_file"])
        sorted_keys = sorted(existing.keys(), reverse=True)
        newest = sorted_keys[0] if sorted_keys else None
        meta["games"][g] = {
            "draws": len(existing),
            "newest": newest,
            "addedThisSync": res.get("added", 0),
            "lastSync": time.strftime("%Y-%m-%dT%H:%M:%S%z")
        }

    with open(HERE / "history_meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    with open(HERE / "history_meta.js", "w", encoding="utf-8") as f:
        f.write("window.HISTORY_META = " + json.dumps(meta) + ";\n")


def run_full_sync():
    """Execute full 24-hour sync across all active games."""
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting 24h Lottery Sync...")
    results = []

    for game_id, cfg in ACTIVE_GAMES.items():
        if "api_url" in cfg:
            res = sync_socrata_game(game_id, cfg)
        else:
            res = sync_wa_game(game_id, cfg)
        results.append(res)
        print(f"  * {cfg['label']} ({game_id}): {res['total']} total draws (+{res['added']} new)")

    update_metadata(results)
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Sync complete. Metadata updated.\n")
    return results


def main():
    if "--cron" in sys.argv or "--loop" in sys.argv:
        print("Running in 24-hour recurring daemon mode...")
        while True:
            try:
                run_full_sync()
            except Exception as e:
                print(f"Sync iteration error: {e}")
            print("Sleeping for 24 hours...")
            time.sleep(24 * 60 * 60)
    else:
        run_full_sync()


if __name__ == "__main__":
    main()
