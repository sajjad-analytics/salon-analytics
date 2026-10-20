"""Collect and tidy monthly data for an Iran inflation-forecasting model.

All sources are pulled from public GitHub mirrors (raw.githubusercontent.com),
because amar.org.ir / cbi.ir / tgju.org are not reachable from every network.
Raw downloads are cached in data/raw/ (git-ignored); tidy outputs go to
data/processed/.

Sources
-------
sci    Statistical Centre of Iran, CPI of all households by main group and by
       province, base 1400=100, 1390-01 .. latest. Workbook mirrored in
       atefekalamati/tse-inflation-analysis (MIT).
cbi    Central Bank of Iran urban CPI ("shakhes-e takhir-e tadiye"), 1375-01 ..
       latest. Mirrored in faustoh9/shakhes.
usd    Free-market USD/IRR daily close from tgju, 2011 .. today.
       kooroshkz/Dollar-Rial-Toman-Live-Price-Dataset (MIT).
torob  Independent e-commerce price index built from Torob listings,
       1404-01 .. latest. mahdi-nasehiyan/the-actual-cpi-in-iran.

Usage:  python iran_inflation/collect_data.py [--refresh]
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

import jdatetime
import numpy as np
import openpyxl
import pandas as pd

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"

GH = "https://raw.githubusercontent.com"
SOURCES = {
    "sci.xlsx": f"{GH}/atefekalamati/tse-inflation-analysis/main/data/external/source/"
                "ts_national_140506-14050719122615.xlsx",
    "cbi.json": f"{GH}/faustoh9/shakhes/main/data/indices.json",
    "usd.csv": f"{GH}/kooroshkz/Dollar-Rial-Toman-Live-Price-Dataset/main/data/"
               "Dollar_Rial_Price_Dataset.csv",
    "torob_prices.csv": f"{GH}/mahdi-nasehiyan/the-actual-cpi-in-iran/main/data/prices.csv",
}

MONTHS_FA = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
             "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]

# Short English keys for the SCI main-group rows used downstream.
SCI_GROUPS = {
    "شاخص کل": "total",
    "خوراکی‌ها، آشامیدنی‌ها و دخانیات": "food_bev_tobacco",
    "011 - خوراکیها": "food",
    "0111 - نان و غلات": "bread_cereals",
    "0112 - گوشت قرمز و گوشت ماکیان": "meat",
    "0113 - ماهی ها و صدف داران": "fish",
    "0114 - شیر، پنیر و تخم مرغ": "dairy_eggs",
    "0115 - روغنها و چربیها": "oils_fats",
    "0116 - میوه و خشکبار": "fruit_nuts",
    "0117 - سبزیجات (سبزی‌ها و حبوبات )": "vegetables_legumes",
    "0118 - شکر، مربا، عسل ، شکلات و شیرینی(قند و شکر و شیرینی‌ها)": "sugar_sweets",
    "012 - چای، قهوه، کاکائو، نوشابه و آب میوه (نوشابه های غیر الکلی)": "beverages",
    "02 - دخانیات": "tobacco",
    "کالاهای غیر خوراکی و خدمات": "nonfood",
    "03 - پوشاک و کفش": "clothing",
    "04 - مسکن ، آب ، برق ، گاز و سایر سوخت‌ها": "housing_utilities",
    "اجاره": "rent",
    "آب ، برق و سوخت": "utilities",
    "05 - مبلمان و لوازم خانگی و نگهداری معمول آنها": "furnishings",
    "06 - بهداشت و درمان": "health",
    "07 - حمل ونقل": "transport",
    "071 - خرید وسایل نقلیه": "vehicles",
    "08 - ارتباطات": "communication",
    "09 - تفریح و فرهنگ": "recreation",
    "10- آموزش": "education",
    "11- هتل و رستوران": "restaurants",
    "12- کالاها و خدمات متفرقه": "misc",
    "کالاها": "goods",
    "خدمات": "services",
    "کالاهای بادوام": "durables",
    "خوراکی های تازه": "fresh_food",
}


def norm(s) -> str:
    """Unify Arabic/Persian letters and whitespace so labels match."""
    s = str(s).replace("ي", "ی").replace("ك", "ک").replace("ئ", "ی").replace("‌", "‌")
    return re.sub(r"\s+", " ", s).strip()


SCI_GROUPS = {norm(k): v for k, v in SCI_GROUPS.items()}


def fetch(name: str, refresh: bool) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / name
    if refresh or not path.exists():
        print(f"downloading {name} ...", file=sys.stderr)
        with urllib.request.urlopen(SOURCES[name], timeout=120) as r:
            path.write_bytes(r.read())
    return path


def ym(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


# ---------------------------------------------------------------- SCI
def _sci_sheet(ws, label_col: int, first_data_col: int) -> pd.DataFrame:
    """Parse a year-block sheet: row 2 holds years, row 3 month names."""
    rows = list(ws.iter_rows(values_only=True))
    years, months = rows[1], rows[2]
    cols, year = {}, None
    for j in range(first_data_col, len(months)):
        if years[j] is not None:
            year = int(re.sub(r"\D", "", str(years[j])))
            m = 0
        if months[j] is None or year is None:
            continue
        m += 1
        cols[j] = ym(year, m)
    recs = []
    for r in rows[3:]:
        if r[label_col] is None:
            continue
        label = norm(r[label_col])
        for j, period in cols.items():
            v = r[j] if j < len(r) else None
            if isinstance(v, (int, float)):
                recs.append((label, period, float(v)))
    return pd.DataFrame(recs, columns=["label", "ym", "value"])


def build_sci(refresh: bool) -> tuple[pd.DataFrame, pd.DataFrame]:
    wb = openpyxl.load_workbook(fetch("sci.xlsx", refresh), read_only=True)
    groups = _sci_sheet(wb["جدول 1"], label_col=0, first_data_col=1)
    groups["group"] = groups["label"].map(SCI_GROUPS)
    groups = groups.dropna(subset=["group"])
    groups = groups.rename(columns={"label": "label_fa", "value": "cpi"})

    prov = _sci_sheet(wb["جدول 7"], label_col=1, first_data_col=2)
    prov = prov.rename(columns={"label": "province_fa", "value": "cpi"})
    return groups[["ym", "group", "label_fa", "cpi"]], prov


# ---------------------------------------------------------------- CBI
def build_cbi(refresh: bool) -> pd.DataFrame:
    data = json.loads(fetch("cbi.json", refresh).read_text(encoding="utf-8"))
    recs = []
    for row in data:
        for i, name in enumerate(MONTHS_FA, start=1):
            v = row.get(name)
            if v is not None:
                recs.append((ym(int(row["سال"]), i), float(v)))
    return pd.DataFrame(recs, columns=["ym", "cbi_cpi"])


# ---------------------------------------------------------------- USD
def build_usd(refresh: bool) -> tuple[pd.DataFrame, pd.DataFrame]:
    d = pd.read_csv(fetch("usd.csv", refresh))
    d = pd.DataFrame({
        "date": pd.to_datetime(d["Gregorian Date"], format="%Y/%m/%d"),
        "usd_close": d["Close Price"].astype(float),
        "usd_high": d["High Price"].astype(float),
        "usd_low": d["Low Price"].astype(float),
    }).sort_values("date").drop_duplicates("date")
    # The source's "Persian Date" column is Gregorian on some rows, so derive
    # the Jalali date from the Gregorian one.
    d["jdate"] = [jdatetime.date.fromgregorian(date=x.date()).strftime("%Y-%m-%d")
                  for x in d["date"]]
    d["ym"] = d["jdate"].str[:7]
    monthly = d.groupby("ym").agg(
        usd_avg=("usd_close", "mean"),
        usd_eom=("usd_close", "last"),
        usd_max=("usd_high", "max"),
        usd_min=("usd_low", "min"),
        usd_days=("usd_close", "size"),
    ).reset_index()
    # intra-month volatility of daily log changes: a cheap market-stress gauge
    d["dlog"] = np.log(d["usd_close"]).diff()
    vol = d.groupby("ym")["dlog"].std().rename("usd_daily_vol").reset_index()
    monthly = monthly.merge(vol, on="ym")
    # last month is usually still running; mark it so models can drop it
    last = jdatetime.date.fromgregorian(date=d["date"].iloc[-1].date())
    monthly["usd_partial_month"] = (monthly["ym"] == last.strftime("%Y-%m")) & (
        last.day < jdatetime.j_days_in_month[last.month - 1])
    return d, monthly


# ---------------------------------------------------------------- Torob
def build_torob(refresh: bool) -> pd.DataFrame:
    """Chained median-price index per category from raw Torob listings.

    For each product we take month-on-month log price changes (only between
    consecutive observed months), take the median change per level-2
    category, and chain it. Level-1 indices are equal-weighted means of their
    level-2 changes. This keeps the index free of product-entry composition
    effects, which a plain normalised-median index does not.
    """
    p = pd.read_csv(fetch("torob_prices.csv", refresh), index_col=0)
    p = p[p["price"] > 0].copy()
    p["ym"] = p["date"].str[:7]
    p = (p.groupby(["cat_level_1", "cat_level_2", "product_title", "ym"])["price"]
           .median().reset_index().sort_values("ym"))
    months = sorted(p["ym"].unique())
    idx = {m: i for i, m in enumerate(months)}
    p["t"] = p["ym"].map(idx)
    g = p.groupby(["cat_level_1", "cat_level_2", "product_title"])
    p["dlog"] = np.log(p["price"]) - np.log(g["price"].shift())
    p.loc[g["t"].diff() != 1, "dlog"] = np.nan
    ch = (p.dropna(subset=["dlog"])
            .groupby(["cat_level_1", "cat_level_2", "ym"])
            .agg(dlog=("dlog", "median"), n=("dlog", "size")).reset_index())
    ch = ch[ch["n"] >= 5]
    lvl1 = ch.groupby(["cat_level_1", "ym"])["dlog"].mean().unstack(0)
    allc = ch.groupby("ym")["dlog"].mean().rename("all")
    lvl1 = lvl1.join(allc).reindex(months).fillna(0.0)
    index = 100 * np.exp(lvl1.cumsum())
    index.index.name = "ym"
    index = index.rename(columns={"مواد-غذایی": "food"})
    return index.reset_index()


# ---------------------------------------------------------------- master
def add_rates(df: pd.DataFrame, col: str, prefix: str) -> None:
    df[f"{prefix}_mom"] = 100 * (df[col] / df[col].shift(1) - 1)
    df[f"{prefix}_yoy"] = 100 * (df[col] / df[col].shift(12) - 1)
    df[f"{prefix}_12m_avg"] = 100 * (df[col].rolling(12).mean()
                                     / df[col].shift(12).rolling(12).mean() - 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download sources")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    sci, prov = build_sci(args.refresh)
    cbi = build_cbi(args.refresh)
    usd_daily, usd = build_usd(args.refresh)
    torob = build_torob(args.refresh)

    sci.to_csv(OUT / "sci_cpi_groups_long.csv", index=False)
    prov.to_csv(OUT / "sci_cpi_provinces_long.csv", index=False)
    cbi.to_csv(OUT / "cbi_cpi_monthly.csv", index=False)
    usd_daily.drop(columns="dlog").to_csv(OUT / "usd_free_daily.csv", index=False)
    usd.to_csv(OUT / "usd_free_monthly.csv", index=False)
    # Torob output is derived from a repository without a licence, so it is
    # written to raw/ (git-ignored) rather than committed.
    torob.to_csv(RAW / "torob_index_monthly.csv", index=False)

    wide = sci.pivot(index="ym", columns="group", values="cpi").add_prefix("sci_")
    allm = sorted(set(cbi["ym"]) | set(wide.index) | set(usd["ym"]))
    m = pd.DataFrame({"ym": allm})
    m = (m.merge(cbi, on="ym", how="left")
          .merge(wide.reset_index(), on="ym", how="left")
          .merge(usd, on="ym", how="left"))
    m = m[m["ym"] >= "1375-01"].reset_index(drop=True)

    for col, pre in [("sci_total", "sci"), ("sci_food", "sci_food"),
                     ("sci_nonfood", "sci_nonfood"), ("cbi_cpi", "cbi"),
                     ("usd_avg", "usd")]:
        add_rates(m, col, pre)

    # Real free-market exchange rate (rial per USD deflated by official CPI).
    # A rising value means the dollar outran official inflation.
    m["usd_real_sci"] = m["usd_avg"] / m["sci_total"]
    m.to_csv(OUT / "master_monthly.csv", index=False)

    print(f"master_monthly: {len(m)} months {m['ym'].iloc[0]}..{m['ym'].iloc[-1]}")
    for name, col in [("CBI CPI", "cbi_cpi"), ("SCI CPI", "sci_total"), ("USD free", "usd_avg")]:
        s = m.dropna(subset=[col])["ym"]
        print(f"  {name:9s} {s.iloc[0]} .. {s.iloc[-1]}  ({len(s)} months)")
    print(f"  Torob     {torob['ym'].iloc[0]} .. {torob['ym'].iloc[-1]}")


if __name__ == "__main__":
    main()
