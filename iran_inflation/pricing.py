"""Price steps that keep a service's real price on target until a freeze date.

Turns the simulated monthly inflation paths of model.forecast into the price
increase needed at each step date so that, between steps, the real price is
centred on today's real price (half above, half below in log terms). This is
the rule used for the salon price plan of 1405-08 (two steps in autumn, no
change until after Nowruz).

Salon services sit in the "other" component (SCI division 12, miscellaneous
goods & services, is inside it), so that component is the default target.

    python iran_inflation/pricing.py --today 1405-08-11 --steps 1405-08-20 1405-09-25 \
        --end 1406-01-15 --component other
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import jdatetime
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import COMPONENTS, forecast, known_fx_after, load_data, next_ym  # noqa: E402


def jdate(s: str) -> jdatetime.date:
    y, m, d = map(int, s.split("-"))
    return jdatetime.date(y, m, d)


def month_start(ym: str) -> jdatetime.date:
    y, m = map(int, ym.split("-"))
    return jdatetime.date(y, m, 1)


def log_level(paths: np.ndarray, months: list[str], day: jdatetime.date) -> np.ndarray:
    """Cumulative 100*log price change from the start of months[0] to `day`.

    Inflation of a month is spread evenly over its days (piecewise geometric).
    """
    out = np.zeros(paths.shape[0])
    for k, ym in enumerate(months):
        a = month_start(ym)
        b = month_start(next_ym(ym))
        length = (b.togregorian() - a.togregorian()).days
        if day <= a:
            break
        frac = min((day.togregorian() - a.togregorian()).days, length) / length
        out += paths[:, k] * frac
    return out


def price_steps(paths, months, today, steps, end):
    """Cumulative % increase vs today's price at each step, per simulated path."""
    ref = log_level(paths, months, today)
    bounds = list(steps) + [end]
    out = []
    for i, s in enumerate(steps):
        a = log_level(paths, months, s) - ref
        b = log_level(paths, months, bounds[i + 1]) - ref
        out.append(100 * (np.exp((a + b) / 2 / 100) - 1))   # log midpoint of the interval
    nochange_end = 100 * (np.exp(-(log_level(paths, months, end) - ref) / 100) - 1)
    return out, nochange_end


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", required=True, help="Jalali YYYY-MM-DD (reference price date)")
    ap.add_argument("--steps", nargs="+", required=True, help="Jalali dates of the price steps")
    ap.add_argument("--end", required=True, help="Jalali date until which the last price holds")
    ap.add_argument("--component", default="other", choices=COMPONENTS + ["total"])
    ap.add_argument("--sims", type=int, default=10000)
    args = ap.parse_args()

    d, w = load_data()
    origin = d["pi_total"].dropna().index[-1]
    _, fx_known = known_fx_after(d, origin)
    f = forecast(d, w, origin, n=args.sims, seed=5, fx_first=fx_known if len(fx_known) else None)
    today, end = jdate(args.today), jdate(args.end)
    steps = [jdate(s) for s in args.steps]
    if end > month_start(next_ym(f.months[-1])):
        sys.exit(f"--end is beyond the forecast horizon ({f.months[-1]})")
    if today < month_start(f.months[0]):
        sys.exit(f"--today must be on or after {f.months[0]}-01 (CPI known up to {origin})")

    cum, nochange = price_steps(f.paths[args.component], f.months, today, steps, end)
    qs = [0.10, 0.25, 0.50, 0.75, 0.90]
    print(f"CPI origin {origin}; component '{args.component}'; FX pinned for {len(fx_known)} month(s)")
    print("cumulative increase vs today's price (%), quantiles " + " / ".join(f"q{int(q*100)}" for q in qs))
    for s, c in zip(args.steps, cum):
        print(f"  step {s}: " + " / ".join(f"{v:+.1f}" for v in np.quantile(c, qs)))
    print(f"  no change, real price at {args.end}: median {np.median(nochange):+.1f}%")


if __name__ == "__main__":
    main()
