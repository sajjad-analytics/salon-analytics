"""Rolling-origin evaluation of the 6-month forecast.

For every origin month t (1395-04 .. last month with 6 months of outcomes)
each model is re-estimated on data up to t only, and its predictive
distribution for the next 6 months is scored against what happened.

Models
------
full     FX regime model + component price equations (model.py)
no_fx    same price equations without FX terms (univariate benchmark)
rw       random walk: next 6 months repeat the average of the last 3,
         with the empirical distribution of this rule's past errors
fx_known `full` given the realised FX path (an oracle, not a forecast):
         measures how much error is due to FX uncertainty

`*_cal` variants apply an online bias/scale correction (conformal-style):
at origin t only origins whose outcome was already known (<= t-6, last
CAL_WINDOW of them) are used, see recalibrate().

Outputs reports/backtest_results.csv, reports/backtest_summary.md and
reports/backtest_*.png.

Usage:  python iran_inflation/backtest.py [--sims 3000] [--jobs 8]
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import HORIZON, MIN_CAL, CAL_WINDOW, forecast, load_data, next_ym, recalibrate  # noqa: E402
from analyze_data import GRID, INK, INK2, SERIES, SURFACE, style  # noqa: E402

ROOT = Path(__file__).resolve().parent
REP = ROOT / "reports"
FIRST_ORIGIN = "1395-04"
LEVELS = (0.5, 0.8, 0.9)
TARGETS = ["total", "food", "housing", "other"]


def crps_sample(x: np.ndarray, y: float) -> float:
    """CRPS from an ensemble: E|X-y| - 0.5 E|X-X'| (sorted-sample form)."""
    x = np.sort(x)
    n = len(x)
    term1 = np.mean(np.abs(x - y))
    term2 = np.sum((2 * np.arange(1, n + 1) - n - 1) * x) / (n * n)
    return term1 - term2


def _one(args):
    origin, sims = args
    d, w = load_data()
    out = []
    for name, use_fx in (("full", True), ("no_fx", False)):
        f = forecast(d, w, origin, n=sims, seed=1, use_fx=use_fx)
        for tgt in TARGETS:
            # 6-month cumulative log inflation (sum of monthly 100*dlog)
            out.append((origin, name, tgt, f.paths[tgt].sum(1)))
    # oracle: the realised FX path is handed to the model. The gap between
    # this and `full` is the share of error that comes from not knowing FX.
    fx_real = d["du"].reindex([next_ym(origin, k + 1) for k in range(HORIZON)]).values
    if not np.isnan(fx_real).any():
        f = forecast(d, w, origin, n=sims, seed=1, fx_path=fx_real)
        for tgt in TARGETS:
            out.append((origin, "fx_known", tgt, f.paths[tgt].sum(1)))
    return out


def realized(d: pd.DataFrame, origin: str, tgt: str) -> float:
    end = next_ym(origin, HORIZON)
    return 100 * np.log(d.loc[end, f"I_{tgt}"] / d.loc[origin, f"I_{tgt}"])


def rw_samples(d: pd.DataFrame, origin: str, tgt: str) -> np.ndarray:
    """Random walk on the 3-month average, errors from its own past record."""
    pi = d[f"pi_{tgt}"].dropna()
    idx = list(pi.index)
    t = idx.index(origin)
    point = 6 * pi.iloc[t - 2:t + 1].mean()
    errs = []
    for s in range(3, t - HORIZON + 1):
        p = 6 * pi.iloc[s - 2:s + 1].mean()
        errs.append(pi.iloc[s + 1:s + 1 + HORIZON].sum() - p)
    return point + np.array(errs)


def evaluate(samples: dict, d: pd.DataFrame, origins: list[str]) -> pd.DataFrame:
    rows = []
    for (o, model, tgt), x in samples.items():
        y = realized(d, o, tgt)
        q = {lv: np.quantile(x, [(1 - lv) / 2, (1 + lv) / 2]) for lv in LEVELS}
        rows.append({
            "origin": o, "model": model, "target": tgt, "y": y,
            "median": float(np.median(x)), "pit": float(np.mean(x <= y)),
            "crps": crps_sample(x, y),
            **{f"lo{int(lv*100)}": q[lv][0] for lv in LEVELS},
            **{f"hi{int(lv*100)}": q[lv][1] for lv in LEVELS},
        })
    r = pd.DataFrame(rows)
    cal = []
    for model in ("full", "fx_known"):
        for tgt in TARGETS:
            base = (r[(r.model == model) & (r.target == tgt)]
                    .sort_values("origin").reset_index(drop=True))
            for i, row in base.iterrows():
                known = base.iloc[max(0, i - HORIZON + 1 - CAL_WINDOW):max(0, i - HORIZON + 1)]
                x = recalibrate(samples[(row.origin, model, tgt)], known)
                new = {**row.to_dict(), "model": f"{model}_cal", "calibrated": len(known) >= MIN_CAL,
                       "median": float(np.median(x)), "pit": float(np.mean(x <= row.y)),
                       "crps": crps_sample(x, row.y)}
                for lv in LEVELS:
                    new[f"lo{int(lv*100)}"], new[f"hi{int(lv*100)}"] = np.quantile(
                        x, [(1 - lv) / 2, (1 + lv) / 2])
                cal.append(new)
    r = pd.concat([r, pd.DataFrame(cal)], ignore_index=True)
    for lv in LEVELS:
        k = int(lv * 100)
        r[f"in{k}"] = (r.y >= r[f"lo{k}"]) & (r.y <= r[f"hi{k}"])
        r[f"width{k}"] = r[f"hi{k}"] - r[f"lo{k}"]
    r["abs_err"] = (r.y - r["median"]).abs()
    return r


def summary(r: pd.DataFrame, since: str | None = None) -> pd.DataFrame:
    x = r if since is None else r[r.origin >= since]
    g = x.groupby(["target", "model"])
    s = pd.DataFrame({
        "n": g.size(),
        "MAE": g.abs_err.mean(),
        "CRPS": g.crps.mean(),
        **{f"cover{int(lv*100)}": 100 * g[f"in{int(lv*100)}"].mean() for lv in LEVELS},
        **{f"width{int(lv*100)}": g[f"width{int(lv*100)}"].mean() for lv in LEVELS},
    })
    return s


def to_md(df: pd.DataFrame) -> str:
    df = df.reset_index()
    head = "| " + " | ".join(df.columns) + " |\n|" + "---|" * len(df.columns) + "\n"
    body = "\n".join("| " + " | ".join(f"{v:.1f}" if isinstance(v, float) else str(v) for v in row) + " |"
                     for row in df.itertuples(index=False))
    return head + body


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=3000)
    ap.add_argument("--jobs", type=int, default=8)
    args = ap.parse_args()
    REP.mkdir(exist_ok=True)
    d, _ = load_data()
    idx = list(d["pi_total"].dropna().index)
    last = idx[-1 - HORIZON]
    origins = [o for o in idx if FIRST_ORIGIN <= o <= last]
    print(f"{len(origins)} origins {origins[0]}..{origins[-1]}", file=sys.stderr)

    samples = {}
    with ProcessPoolExecutor(args.jobs) as ex:
        for res in ex.map(_one, [(o, args.sims) for o in origins]):
            for o, model, tgt, x in res:
                samples[(o, model, tgt)] = x
    for o in origins:
        for tgt in TARGETS:
            samples[(o, "rw", tgt)] = rw_samples(d, o, tgt)

    r = evaluate(samples, d, origins)
    r.to_csv(REP / "backtest_results.csv", index=False)
    cal_start = r[(r.model == "full_cal") & r.calibrated.fillna(False).astype(bool)].origin.min()
    s_all = summary(r[~r.model.str.endswith("_cal")])
    s_cal = summary(r, since=cal_start)
    s_recent = summary(r, since="1401-01")
    md = ["# Backtest: 6-month cumulative inflation (100 x log change)\n",
          f"Origins {origins[0]}..{origins[-1]} ({len(origins)}), re-estimated each month.\n",
          "## All origins (uncalibrated models)\n", to_md(s_all),
          f"\n\n## Origins from {cal_start} (where recalibration is active)\n", to_md(s_cal),
          "\n\n## Origins from 1401-01 (high-inflation period)\n", to_md(s_recent), "\n"]
    (REP / "backtest_summary.md").write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md))
    plot(r, d)


def plot(r: pd.DataFrame, d: pd.DataFrame) -> None:
    x = r[(r.model == "full") & (r.target == "total")].sort_values("origin")
    fig, ax = plt.subplots(figsize=(9, 4.5))
    style(ax, "Backtest: 6-month headline inflation, 80% and 50% intervals vs outcome",
          "% (100 x log change over 6 months)")
    t = np.arange(len(x))
    ax.fill_between(t, x.lo80, x.hi80, color=SERIES[0], alpha=0.18, linewidth=0, label="80% interval")
    ax.fill_between(t, x.lo50, x.hi50, color=SERIES[0], alpha=0.35, linewidth=0, label="50% interval")
    ax.plot(t, x["median"], color=SERIES[0], linewidth=1.5, label="median forecast")
    miss = ~x.in80.values
    ax.plot(t, x.y, color=INK, linewidth=0, marker="o", markersize=3, label="outcome")
    ax.plot(t[miss], x.y.values[miss], color=SERIES[1], linewidth=0, marker="o", markersize=5,
            label="outcome outside 80%")
    step = max(1, len(x) // 10)
    ax.set_xticks(t[::step], x.origin.values[::step])
    ax.set_xlabel("forecast origin (outcome is 6 months later)", color=INK2)
    ax.legend(frameon=False, labelcolor=INK2, fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(REP / "backtest_intervals.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    main()
