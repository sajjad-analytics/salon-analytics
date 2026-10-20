"""Diagnostics on the collected data: official vs independent measures,
dispersion across CPI groups, and how past FX-shock episodes played out.

Reads data/processed/ (run collect_data.py first) and writes
reports/data_report_tables.md plus PNG charts into reports/.

Usage:  python iran_inflation/analyze_data.py
"""
from __future__ import annotations

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.optimize import nnls

ROOT = Path(__file__).resolve().parent
P = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"
REP = ROOT / "reports"

# reference palette (light mode), see dataviz skill
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
NEUTRAL = "#a3a29d"

DIVISIONS = ["food_bev_tobacco", "clothing", "housing_utilities", "furnishings",
             "health", "transport", "communication", "recreation", "education",
             "restaurants", "misc"]


def style(ax, title: str, ylabel: str) -> None:
    ax.set_facecolor(SURFACE)
    ax.figure.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", color=INK, fontsize=12)
    ax.set_ylabel(ylabel, color=INK2)
    ax.tick_params(colors=INK2, labelsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for s in ["top", "right"]:
        ax.spines[s].set_visible(False)
    for s in ["left", "bottom"]:
        ax.spines[s].set_color(GRID)


def shift_ym(ym: str, k: int) -> str:
    y, m = map(int, ym.split("-"))
    n = y * 12 + (m - 1) + k
    return f"{n // 12:04d}-{n % 12 + 1:02d}"


def md_table(df: pd.DataFrame, floatfmt: str = "{:.1f}") -> str:
    cols = [str(c) for c in df.columns]
    out = ["| " + " | ".join([df.index.name or ""] + cols) + " |",
           "|" + "---|" * (len(cols) + 1)]
    for idx, row in df.iterrows():
        cells = [floatfmt.format(v) if isinstance(v, (float, np.floating)) and not np.isnan(v)
                 else ("" if isinstance(v, float) else str(v)) for v in row]
        out.append("| " + " | ".join([str(idx)] + cells) + " |")
    return "\n".join(out)


def basket_weights(groups: pd.DataFrame) -> pd.Series:
    """Recover SCI base-1400 division weights.

    The SCI index is Laspeyres on base 1400, so total_t = sum_i w_i * I_i,t
    holds exactly; non-negative least squares on the levels recovers w.
    """
    g = groups.loc["1400-01":, DIVISIONS + ["total"]].dropna()
    w, _ = nnls(g[DIVISIONS].values, g["total"].values)
    return pd.Series(w / w.sum(), index=DIVISIONS)


def personal_index(groups: pd.DataFrame, weights: dict[str, float]) -> pd.Series:
    """CPI for a custom basket (weights over DIVISIONS, base-1400 shares)."""
    w = pd.Series(weights).reindex(DIVISIONS).fillna(0.0)
    w = w / w.sum()
    return (groups.loc["1400-01":, DIVISIONS] * w).sum(axis=1)


def find_episodes(m: pd.DataFrame, thresh: float = 20.0, gap: int = 6) -> list[str]:
    """First month of each cluster where the free USD rose > thresh % in 3 months."""
    u = np.log(m["usd_avg"])
    d3 = 100 * (u - u.shift(3))
    hits = list(d3[d3 > thresh].index)
    starts, last = [], None
    for h in hits:
        if last is None or _months_between(last, h) > gap:
            starts.append(h)
        last = h
    return starts


def _months_between(a: str, b: str) -> int:
    ya, ma = map(int, a.split("-"))
    yb, mb = map(int, b.split("-"))
    return (yb - ya) * 12 + (mb - ma)


def episode_table(m: pd.DataFrame, starts: list[str], horizon: int = 12) -> tuple[pd.DataFrame, dict]:
    rows, paths = [], {}
    for s in starts:
        base = shift_ym(s, -3)          # month before the 3-month FX jump began
        months = [shift_ym(base, k) for k in range(horizon + 1)]
        sub = m.reindex(months)
        cpi = sub["sci_total"]
        food = sub["sci_food"]
        usd = sub["usd_avg"]
        cum_cpi = 100 * (cpi / cpi.iloc[0] - 1)
        paths[s] = cum_cpi.values
        avail = cpi.notna().sum() - 1
        end = months[avail]
        dl_cpi = np.log(cpi.loc[end] / cpi.iloc[0])
        dl_usd = np.log(usd.loc[end] / usd.iloc[0])
        mom = 100 * cpi.pct_change()
        rows.append({
            "episode": s,
            "months_observed": avail,
            "usd_change_%": 100 * (usd.loc[end] / usd.iloc[0] - 1),
            "cpi_change_%": cum_cpi.loc[end] if hasattr(cum_cpi, "loc") else np.nan,
            "food_change_%": 100 * (food.loc[end] / food.iloc[0] - 1),
            "pass_through": dl_cpi / dl_usd if dl_usd > 0 else np.nan,
            "peak_mom_%": mom.max(),
            "peak_yoy_%": m.reindex(months)["sci_yoy"].max(),
        })
    t = pd.DataFrame(rows).set_index("episode")
    return t, paths


def main() -> None:
    REP.mkdir(exist_ok=True)
    m = pd.read_csv(P / "master_monthly.csv").set_index("ym")
    m = m[~m["usd_partial_month"].fillna(False).astype(bool)]
    long = pd.read_csv(P / "sci_cpi_groups_long.csv")
    g = long.pivot(index="ym", columns="group", values="cpi")
    out: list[str] = []

    # 1) official SCI vs CBI
    gap = (m["sci_yoy"] - m["cbi_yoy"]).dropna()
    out.append("## SCI minus CBI point-to-point inflation (pp)\n")
    out.append(md_table(gap.groupby(gap.index.str[:4]).mean().to_frame("mean_gap_pp")))

    # 2) Torob vs SCI over the overlap
    tpath = RAW / "torob_index_monthly.csv"
    if tpath.exists():
        t = pd.read_csv(tpath).set_index("ym")
        a, b = t.index[0], t.index[-1]
        comp = pd.DataFrame({
            "Torob (market listings)": [t.loc[b, "all"] / t.loc[a, "all"], t.loc[b, "food"] / t.loc[a, "food"]],
            "SCI official": [g.loc[b, "goods"] / g.loc[a, "goods"], g.loc[b, "food"] / g.loc[a, "food"]],
        }, index=pd.Index(["goods (all)", "food"], name=f"{a}..{b}"))
        out.append(f"\n## Cumulative price change {a} to {b} (%)\n")
        out.append(md_table(100 * (comp - 1)))
        tf, sf = np.log(t["food"]).diff(), np.log(g["food"]).diff().reindex(t.index)
        out.append(f"\nCorrelation of monthly food changes Torob vs SCI: {tf.corr(sf):.2f}\n")

        fig, ax = plt.subplots(figsize=(8, 4.2))
        style(ax, f"Price index, {a} = 100", "index")
        lines = {
            "SCI goods (official)": 100 * g.loc[a:b, "goods"] / g.loc[a, "goods"],
            "Torob goods (market)": t["all"],
            "SCI headline incl. rent": 100 * g.loc[a:b, "total"] / g.loc[a, "total"],
        }
        for (name, s), c in zip(lines.items(), SERIES):
            ax.plot(range(len(s)), s.values, color=c, linewidth=2, label=name)
            ax.annotate(f"{s.iloc[-1]:.0f}", (len(s) - 1, s.iloc[-1]), xytext=(4, 0),
                        textcoords="offset points", color=INK2, fontsize=9, va="center")
        ax.set_xticks(range(0, len(t), 3), t.index[::3])
        ax.legend(frameon=False, labelcolor=INK2, fontsize=9)
        fig.tight_layout()
        fig.savefig(REP / "official_vs_market.png", dpi=150)
        plt.close(fig)

    # 3) dispersion across groups, latest month
    last = g["total"].dropna().index[-1]
    yoy = (100 * (g / g.shift(12) - 1)).loc[last].dropna().sort_values()
    out.append(f"\n## Point-to-point inflation by group, {last} (%)\n")
    out.append(md_table(yoy.to_frame("yoy_%")))

    fig, ax = plt.subplots(figsize=(8, 8))
    style(ax, f"Point-to-point inflation by CPI group, {last}", "")
    colors = [SERIES[1] if k == "total" else (SERIES[0]) for k in yoy.index]
    ax.barh(yoy.index, yoy.values, color=colors, height=0.7)
    for i, v in enumerate(yoy.values):
        ax.text(v + 2, i, f"{v:.0f}%", va="center", color=INK2, fontsize=8)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("% change vs same month last year (orange = headline)", color=INK2)
    fig.tight_layout()
    fig.savefig(REP / "inflation_by_group.png", dpi=150)
    plt.close(fig)

    # 4) basket weights and alternative baskets
    w = basket_weights(g)
    out.append("\n## Recovered SCI base-1400 division weights\n")
    out.append(md_table((100 * w).to_frame("weight_%")))
    food_heavy = dict(w)
    food_heavy["food_bev_tobacco"] = 0.45
    food_heavy["housing_utilities"] = 0.25
    no_rent_bias = dict(w)
    no_rent_bias["housing_utilities"] = 0.0
    baskets = {
        "official": personal_index(g, dict(w)),
        "low_income (food 45%, housing 25%)": personal_index(g, food_heavy),
        "excluding housing": personal_index(g, no_rent_bias),
    }
    bt = pd.DataFrame({k: 100 * (v / v.shift(12) - 1) for k, v in baskets.items()})
    out.append("\n## Point-to-point inflation for alternative baskets (%)\n")
    out.append(md_table(bt.dropna().iloc[-12:]))

    # 5) FX-shock episodes
    starts = find_episodes(m)
    et, paths = episode_table(m, starts)
    out.append("\n## FX-shock episodes (free USD +20% in 3 months), 12 months from base\n")
    out.append(md_table(et, "{:.2f}"))

    fig, ax = plt.subplots(figsize=(8, 4.5))
    style(ax, "Cumulative CPI inflation after an FX shock begins", "% since base month")
    for (s, path), c in zip(paths.items(), SERIES):
        ax.plot(range(len(path)), path, color=c, linewidth=2, label=s, marker="o", markersize=3)
        ok = ~np.isnan(path)
        k = np.where(ok)[0][-1]
        ax.annotate(s, (k, path[k]), xytext=(4, 0), textcoords="offset points",
                    color=INK2, fontsize=8, va="center")
    ax.set_xlabel("months after base (base = 3 months before the jump peaks)", color=INK2)
    ax.legend(frameon=False, labelcolor=INK2, fontsize=8, ncol=3)
    fig.tight_layout()
    fig.savefig(REP / "fx_shock_episodes.png", dpi=150)
    plt.close(fig)

    # 6) volatility regimes from the long CBI series
    mom = 100 * np.log(m["cbi_cpi"]).diff()
    yr = mom.groupby(mom.index.str[:4]).agg(["mean", "std", "max"])
    yr.index.name = "year"
    out.append("\n## CBI monthly inflation by year (log %, mean / std / max)\n")
    out.append(md_table(yr, "{:.2f}"))

    (REP / "data_report_tables.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
