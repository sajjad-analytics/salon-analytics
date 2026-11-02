"""Backtest of the nowcast mode: month-1 inflation when that month's FX is known.

The published report pins the FX moves already observed after the last CPI
month (see model.known_fx_after). backtest.py never scored that mode: it only
scores 6-month cumulative inflation with simulated or oracle FX. This script
scores month-1 headline and food inflation for

    pinned_hl60   FX of month 1 pinned, half-life 60 months (production)
    pinned_hl24   same, half-life 24 months (faster adaptation; tests whether
                  pass-through has recently changed, e.g. weaker in recession)
    simulated     FX of month 1 simulated (no nowcast)

The month-1 FX move is the full-month average, slightly more information than
a month-to-date average at publication time.

Outputs reports/backtest_nowcast.csv and reports/backtest_nowcast.md.

Usage:  python iran_inflation/backtest_nowcast.py [--sims 1500] [--jobs 2]
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import forecast, load_data, next_ym  # noqa: E402

ROOT = Path(__file__).resolve().parent
REP = ROOT / "reports"
FIRST_ORIGIN = "1395-04"
VARIANTS = {"pinned_hl60": dict(pin=True, half_life=60),
            "pinned_hl24": dict(pin=True, half_life=24),
            "simulated": dict(pin=False, half_life=60)}


def _one(args):
    origin, sims = args
    d, w = load_data()
    m1 = next_ym(origin)
    out = []
    for name, v in VARIANTS.items():
        f = forecast(d, w, origin, n=sims, seed=1, half_life=v["half_life"],
                     fx_first=d.loc[m1, "du"] if v["pin"] else None)
        for tgt in ("total", "food"):
            x = f.paths[tgt][:, 0]
            y = d.loc[m1, f"pi_{tgt}"]
            lo, hi = np.quantile(x, [0.1, 0.9])
            out.append(dict(origin=origin, month=m1, variant=name, target=tgt, du=d.loc[m1, "du"],
                            y=y, median=float(np.median(x)), lo80=lo, hi80=hi,
                            pit=float(np.mean(x <= y))))
    return out


def table(r: pd.DataFrame) -> str:
    g = r.groupby(["target", "variant"])
    s = pd.DataFrame({"n": g.size(),
                      "bias (y-med)": g.apply(lambda x: (x.y - x["median"]).mean()),
                      "MAE": g.apply(lambda x: (x.y - x["median"]).abs().mean()),
                      "cover80 %": g.apply(lambda x: 100 * ((x.y >= x.lo80) & (x.y <= x.hi80)).mean()),
                      "mean PIT": g.pit.mean()}).reset_index()
    head = "| " + " | ".join(s.columns) + " |\n|" + "---|" * len(s.columns) + "\n"
    return head + "\n".join("| " + " | ".join(f"{v:.2f}" if isinstance(v, float) else str(v) for v in row) + " |"
                            for row in s.itertuples(index=False))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=1500)
    ap.add_argument("--jobs", type=int, default=2)
    args = ap.parse_args()
    d, _ = load_data()
    idx = list(d["pi_total"].dropna().index)
    origins = [o for o in idx[:-1] if o >= FIRST_ORIGIN and pd.notna(d.loc[next_ym(o), "du"])]
    rows = []
    with ProcessPoolExecutor(args.jobs) as ex:
        for res in ex.map(_one, [(o, args.sims) for o in origins]):
            rows += res
    r = pd.DataFrame(rows)
    r.to_csv(REP / "backtest_nowcast.csv", index=False)
    manual = d.attrs.get("manual_months", [])
    md = ["# Backtest: month-1 inflation with month-1 FX known (nowcast mode)\n",
          f"Origins {origins[0]}..{origins[-1]} ({len(origins)}). Units: 100 x log change in one month.",
          f"Outcomes for {', '.join(manual)} come from data/manual/sci_latest.csv.\n" if manual else "",
          "## All months\n", table(r),
          "\n\n## Months with an FX jump (du > 8)\n", table(r[r.du > 8]),
          "\n\n## Since 1404-01\n", table(r[r.month >= "1404-01"]),
          "\n\n## Last 6 months (headline)\n",
          r[(r.target == "total") & (r.month >= idx[-6])].round(2).to_markdown(index=False)
          if hasattr(pd.DataFrame, "to_markdown") else ""]
    text = "\n".join(md) + "\n"
    (REP / "backtest_nowcast.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
