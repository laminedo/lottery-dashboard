#!/usr/bin/env python3
"""Refresh every bundled lottery history file for active games:
- Mega Millions + Powerball: NY Open Data Socrata API
- WA games (Hit 5, WA Lotto): Official feeds / scrapers

Writes a summary to stdout (JSON) and updates history_meta.json/js.
"""
import csv
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

NY_SOURCES = {
    "mega": ("5xaw-6ayf", "mega_history.json", "mega_history.csv"),
    "powerball": ("d6yy-54nr", "powerball_history.json", "powerball_history.csv"),
}
WA_SCRAPERS = [
    "fetch_hit5_history.py",
    "fetch_walotto_history.py",
]


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def count_draws(path):
    try:
        return len(json.load(open(path)))
    except Exception:
        return None


def refresh_ny_game(game, dataset, json_name, csv_name):
    url = (f"https://data.ny.gov/resource/{dataset}.json"
           "?$limit=50000&$order=draw_date%20DESC")
    rows = fetch_json(url)
    out = []
    for r in rows:
        winning_raw = r.get("winning_numbers", "")
        winning_nums = [int(x) for x in winning_raw.strip().split() if x.isdigit()]
        bonus_nums = []
        if r.get("mega_ball") and str(r["mega_ball"]).isdigit():
            bonus_nums = [int(r["mega_ball"])]
        jackpot = str(r.get("jackpot_amount") or r.get("estimated_jackpot") or "N/A")

        rec = {
            "draw_date": r["draw_date"][:10],
            "winning_numbers": sorted(winning_nums),
            "bonus_numbers": bonus_nums,
            "jackpot_amount": jackpot
        }
        out.append(rec)

    json_path = HERE / json_name
    before = count_draws(json_path)
    json.dump(out, open(json_path, "w"), indent=1)
    with open(HERE / csv_name, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["draw_date", "winning_numbers", "bonus_numbers", "jackpot_amount"])
        for r in out:
            w.writerow([
                r["draw_date"],
                " ".join(map(str, r["winning_numbers"])),
                " ".join(map(str, r["bonus_numbers"])),
                r["jackpot_amount"]
            ])
    return {"game": game, "ok": True, "draws": len(out), "previous": before,
            "newest": out[0]["draw_date"] if out else None}


def run_scraper(script):
    start = time.time()
    proc = subprocess.run([sys.executable, str(HERE / script)],
                          capture_output=True, text=True, timeout=1800)
    game = script.replace("fetch_", "").replace("_history.py", "")
    json_path = HERE / f"{game}_history.json"
    return {"game": game, "ok": proc.returncode == 0,
            "draws": count_draws(json_path),
            "seconds": round(time.time() - start, 1),
            "error": (proc.stderr or proc.stdout)[-400:] if proc.returncode != 0 else None}


def write_meta(results):
    """Summary file the dashboard reads to show per-game data health."""
    meta = {}
    for r in results:
        path = HERE / f"{r['game']}_history.json"
        try:
            rows = json.load(open(path))
            meta[r["game"]] = {
                "draws": len(rows),
                "newest": rows[0]["draw_date"] if rows else None,
                "oldest": rows[-1]["draw_date"] if rows else None,
            }
        except Exception:
            meta[r["game"]] = {"draws": r.get("draws"), "newest": None, "oldest": None}
    payload = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "games": meta}
    json.dump(payload, open(HERE / "history_meta.json", "w"), indent=1)
    with open(HERE / "history_meta.js", "w") as f:
        f.write("window.HISTORY_META = " + json.dumps(payload) + ";\n")


def main():
    results = []
    for game, (dataset, json_name, csv_name) in NY_SOURCES.items():
        try:
            results.append(refresh_ny_game(game, dataset, json_name, csv_name))
        except Exception as exc:
            results.append({"game": game, "ok": False, "draws": count_draws(HERE / json_name), "error": str(exc)[:400]})
    for script in WA_SCRAPERS:
        game = script.replace("fetch_", "").replace("_history.py", "")
        try:
            results.append(run_scraper(script))
        except Exception as exc:
            results.append({"game": game, "ok": False, "draws": count_draws(HERE / f"{game}_history.json"), "error": str(exc)[:400]})
    write_meta(results)
    summary = {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "games": results,
        "allOk": all(r.get("ok") for r in results),
        "totalDraws": sum(r.get("draws") or 0 for r in results),
    }
    print(json.dumps(summary, indent=1))
    return 0 if summary["allOk"] else 1


if __name__ == "__main__":
    sys.exit(main())
