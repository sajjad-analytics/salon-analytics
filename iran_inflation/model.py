"""Probabilistic 6-month inflation forecast for Iran.

Structure
---------
1. FX block: monthly log change of the free-market USD follows a two-regime
   Markov-switching AR(1) (calm / crisis, switching mean and variance).
2. Price block: monthly inflation of three CPI components (food+beverages+
   tobacco, housing+utilities, everything else) is a weighted ridge
   regression on its own lags, lagged headline inflation, current and lagged
   FX changes and a shrunk month-of-year effect. Observations are discounted
   exponentially (half-life HALF_LIFE months) because FX pass-through has
   roughly doubled since the 1390s.
3. Simulation: FX paths are drawn from the regime model; component shocks are
   bootstrapped jointly (one historical month = one residual vector, so the
   cross-component correlation is kept) from months in the same FX regime as
   the simulated one, which gives fatter tails in crisis.
4. Headline and any custom basket are aggregated bottom-up with the SCI
   base-1400 weights.

Usage
-----
    python iran_inflation/model.py forecast      # forecast from the latest month
    python iran_inflation/backtest.py            # rolling-origin evaluation
"""
from __future__ import annotations

import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.tsa.regime_switching.markov_autoregression import MarkovAutoregression

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_data import basket_weights  # noqa: E402

ROOT = Path(__file__).resolve().parent
P = ROOT / "data" / "processed"

COMPONENTS = ["food", "housing", "other"]
HORIZON = 6
HALF_LIFE = 60          # months; weight of an observation halves every 5 years
RIDGE_SEASON = 6.0      # prior strength (in effective months) on seasonal terms
RIDGE_OTHER = 0.5
FX_LAG_AVG = (3, 5)     # months t-3..t-5 enter as one averaged term


# ------------------------------------------------------------------ data
def load_data() -> tuple[pd.DataFrame, dict[str, float]]:
    """Monthly frame with component indices, inflation (100*dlog) and FX change."""
    m = pd.read_csv(P / "master_monthly.csv").set_index("ym")
    usd = m.loc[~m["usd_partial_month"].fillna(False).astype(bool), "usd_avg"]
    g = (pd.read_csv(P / "sci_cpi_groups_long.csv")
           .pivot(index="ym", columns="group", values="cpi"))
    w = basket_weights(g)
    wf, wh = w["food_bev_tobacco"], w["housing_utilities"]
    wo = 1.0 - wf - wh
    # "other" is backed out so that total = wf*F + wh*H + wo*O holds exactly
    other = (g["total"] - wf * g["food_bev_tobacco"] - wh * g["housing_utilities"]) / wo
    d = pd.DataFrame({
        "I_food": g["food_bev_tobacco"],
        "I_housing": g["housing_utilities"],
        "I_other": other,
        "I_total": g["total"],
    }).dropna()
    for c in COMPONENTS + ["total"]:
        d[f"pi_{c}"] = 100 * np.log(d[f"I_{c}"]).diff()
    d = d.join(usd.rename("usd"), how="outer").sort_index()
    d["du"] = 100 * np.log(d["usd"]).diff()
    d["month"] = d.index.str[5:7].astype(int)
    weights = {"food": wf, "housing": wh, "other": wo}
    return d, weights


def partial_month_usd() -> tuple[str, float] | None:
    """Average free USD of the running (incomplete) month, if any."""
    m = pd.read_csv(P / "master_monthly.csv")
    last = m.dropna(subset=["usd_avg"]).iloc[-1]
    if bool(last.get("usd_partial_month", False)):
        return last["ym"], float(last["usd_avg"])
    return None


def next_ym(ym: str, k: int = 1) -> str:
    y, mth = map(int, ym.split("-"))
    n = y * 12 + (mth - 1) + k
    return f"{n // 12:04d}-{n % 12 + 1:02d}"


# ------------------------------------------------------------------ FX block
@dataclass
class FXModel:
    mu: np.ndarray            # regime means (calm, crisis)
    sigma: np.ndarray         # regime std devs
    phi: float
    P: np.ndarray             # P[i, j] = Pr(S_t = j | S_{t-1} = i)
    p_last: np.ndarray        # filtered regime probabilities at the origin
    du_last: float
    crisis_prob: pd.Series    # smoothed Pr(crisis) over the sample

    @classmethod
    def fit(cls, du: pd.Series) -> "FXModel":
        du = du.dropna()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            mod = MarkovAutoregression(du.values, k_regimes=2, order=1,
                                       switching_ar=False, switching_variance=True)
            best = None
            for seed in range(4):
                np.random.seed(seed)    # statsmodels' random start search
                try:
                    r = mod.fit(search_reps=20, search_iter=10, disp=False)
                except Exception:   # pragma: no cover - optimiser failures
                    continue
                if best is None or r.llf > best.llf:
                    best = r
        par = dict(zip(mod.param_names, best.params))
        mu = np.array([par["const[0]"], par["const[1]"]])
        sig = np.sqrt([par["sigma2[0]"], par["sigma2[1]"]])
        p00, p10 = par["p[0->0]"], par["p[1->0]"]
        Pm = np.array([[p00, 1 - p00], [p10, 1 - p10]])
        filt = np.asarray(best.filtered_marginal_probabilities)
        smooth = np.asarray(best.smoothed_marginal_probabilities)
        crisis = int(np.argmax(sig))         # label the high-variance regime 1
        order = [1 - crisis, crisis]
        idx = du.index[1:]                   # AR(1) drops the first observation
        return cls(mu[order], sig[order], par["ar.L1"], Pm[np.ix_(order, order)],
                   filt[-1][order], float(du.iloc[-1]),
                   pd.Series(smooth[:, crisis], index=idx))

    def filter_path(self, path: np.ndarray) -> np.ndarray:
        """Pr(crisis) in each month of a given FX path (Hamilton filter)."""
        p = self.p_last.copy()
        prev = self.du_last
        out = []
        for x in path:
            pred = p @ self.P
            mu_prev = p @ self.mu
            mean = self.mu + self.phi * (prev - mu_prev)
            lik = np.exp(-0.5 * ((x - mean) / self.sigma) ** 2) / self.sigma
            p = pred * lik
            p = p / p.sum()
            out.append(p[1])
            prev = x
        return np.array(out)

    def simulate(self, n: int, h: int, rng: np.random.Generator,
                 first: float | None = None) -> tuple[np.ndarray, np.ndarray]:
        """Return (du paths [n,h], regime paths [n,h]). `first` pins month 1."""
        du = np.empty((n, h))
        st = np.empty((n, h), dtype=int)
        prev_s = (rng.random(n) < self.p_last[1]).astype(int)
        prev_du = np.full(n, self.du_last)
        for k in range(h):
            s = (rng.random(n) < self.P[prev_s, 1]).astype(int)
            mean = self.mu[s] + self.phi * (prev_du - self.mu[prev_s])
            x = mean + self.sigma[s] * rng.standard_normal(n)
            if k == 0 and first is not None:
                x = np.full(n, first)
                # regime most consistent with the observed move
                lik = np.stack([np.exp(-0.5 * ((first - (self.mu[j] + self.phi * (prev_du - self.mu[prev_s])))
                                               / self.sigma[j]) ** 2) / self.sigma[j] for j in (0, 1)], 1)
                pr = lik[:, 1] * self.P[prev_s, 1]
                pr = pr / (pr + lik[:, 0] * self.P[prev_s, 0])
                s = (rng.random(n) < pr).astype(int)
            du[:, k], st[:, k] = x, s
            prev_s, prev_du = s, x
        return du, st


# ------------------------------------------------------------------ price block
def _features(pi_own_1, pi_own_23, pi_tot_1, du0, du1, du2, du35, month, use_fx=True):
    n = np.size(pi_own_1)
    cols = [np.ones(n), pi_own_1, pi_own_23, pi_tot_1]
    if use_fx:
        cols += [du0, du1, du2, du35]
    season = np.zeros((n, 11))
    mm = np.asarray(month)
    for j in range(1, 12):           # month 12 is the reference, centred below
        season[:, j - 1] = (mm == j).astype(float) - 1.0 / 12
    return np.column_stack(cols + [season])


@dataclass
class PriceModel:
    beta: dict[str, np.ndarray]
    resid: pd.DataFrame        # training residuals (rows = months)
    obs_w: pd.Series           # discount weight of each training month
    use_fx: bool = True
    n_fixed: int = field(init=False)

    def __post_init__(self):
        self.n_fixed = 8 if self.use_fx else 4

    @classmethod
    def fit(cls, d: pd.DataFrame, use_fx: bool = True) -> "PriceModel":
        x = d.copy()
        x["du35"] = x["du"].shift(FX_LAG_AVG[0]).rolling(FX_LAG_AVG[1] - FX_LAG_AVG[0] + 1).mean()
        x = x.dropna(subset=[f"pi_{c}" for c in COMPONENTS] + (["du", "du35"] if use_fx else []))
        need_lags = 6 if use_fx else 3
        x = x.iloc[need_lags:]
        t = np.arange(len(x))
        w = 0.5 ** ((t[-1] - t) / HALF_LIFE)
        betas, res = {}, {}
        for c in COMPONENTS:
            pi = d[f"pi_{c}"]
            X = _features(pi.shift(1).reindex(x.index), pi.shift(2).rolling(2).mean().reindex(x.index),
                          d["pi_total"].shift(1).reindex(x.index),
                          d["du"].reindex(x.index), d["du"].shift(1).reindex(x.index),
                          d["du"].shift(2).reindex(x.index), x["du35"], x["month"], use_fx)
            y = x[f"pi_{c}"].values
            ok = ~np.isnan(X).any(1)
            X, y, ww = X[ok], y[ok], w[ok]
            k_fixed = 8 if use_fx else 4
            lam = np.r_[0.0, np.full(k_fixed - 1, RIDGE_OTHER), np.full(11, RIDGE_SEASON)]
            A = X.T @ (X * ww[:, None]) + np.diag(lam)
            b = np.linalg.solve(A, X.T @ (y * ww))
            betas[c] = b
            res[c] = pd.Series(y - X @ b, index=x.index[ok])
        resid = pd.DataFrame(res).dropna()
        obs_w = pd.Series(w, index=x.index).reindex(resid.index)
        return cls(betas, resid, obs_w, use_fx)


# ------------------------------------------------------------------ forecaster
@dataclass
class Forecast:
    origin: str
    months: list[str]
    paths: dict[str, np.ndarray]     # component/total monthly inflation [n, h] (100*dlog)
    du: np.ndarray
    level0: dict[str, float]         # index levels at origin
    known6: dict[str, float]         # log change over the 6 months up to the origin
    weights: dict[str, float]

    def cumulative(self, basket: dict[str, float] | None = None) -> np.ndarray:
        """Simulated % change of the (basket) index over the horizon."""
        if basket is None:
            return 100 * (np.exp(self.paths["total"].sum(1) / 100) - 1)
        w = self._shares(basket)
        rel = sum(w[c] * np.exp(self.paths[c].sum(1) / 100) for c in COMPONENTS)
        return 100 * (rel - 1)

    def yoy_at_horizon(self, basket: dict[str, float] | None = None) -> np.ndarray:
        """Point-to-point inflation in the last forecast month (needs h=6)."""
        cum = 1 + self.cumulative(basket) / 100
        if basket is None:
            known = np.exp(self.known6["total"] / 100)
        else:
            w6 = self._shares(basket, at="past6")
            known = sum(w6[c] * np.exp(self.known6[c] / 100) for c in COMPONENTS)
        return 100 * (known * cum - 1)

    def _shares(self, basket, at="origin"):
        # basket weights are base-period expenditure shares; turn them into
        # value shares at the reference month so a Laspeyres basket aggregates
        lv = self.level0 if at == "origin" else self.level_past6
        raw = {c: basket.get(c, 0.0) * lv[c] for c in COMPONENTS}
        s = sum(raw.values())
        return {c: v / s for c, v in raw.items()}


def forecast(d: pd.DataFrame, weights: dict[str, float], origin: str, n: int = 10000,
             h: int = HORIZON, seed: int = 0, use_fx: bool = True,
             fx_first: float | None = None, fx_path: np.ndarray | None = None) -> Forecast:
    """Simulate h months ahead using data up to and including `origin`."""
    rng = np.random.default_rng(seed)
    hist = d.loc[:origin]
    pm = PriceModel.fit(hist, use_fx=use_fx)
    du_hist = hist["du"].dropna()
    fx = FXModel.fit(du_hist)

    if fx_path is not None:          # scenario: deterministic FX path
        du = np.tile(np.asarray(fx_path, float), (n, 1))
        pr = fx.filter_path(np.asarray(fx_path, float))
        reg = (rng.random((n, h)) < pr[None, :]).astype(int)
    else:
        du, reg = fx.simulate(n, h, rng, first=fx_first)

    # residual pools by regime, sampled with discount weights
    cp = fx.crisis_prob.reindex(pm.resid.index).fillna(0.0).values
    pools = {}
    for s in (0, 1):
        mask = (cp > 0.5) if s == 1 else (cp <= 0.5)
        if mask.sum() < 12:          # too few months: fall back to all
            mask = np.ones_like(cp, bool)
        R = pm.resid.values[mask]
        ww = pm.obs_w.values[mask]
        pools[s] = (R, ww / ww.sum())
    if not use_fx:                   # benchmark ignores regimes
        R, ww = pm.resid.values, pm.obs_w.values
        pools = {0: (R, ww / ww.sum()), 1: (R, ww / ww.sum())}

    lag = {c: np.tile(hist[f"pi_{c}"].iloc[-3:].values, (n, 1)) for c in COMPONENTS + ["total"]}
    du_lag = np.tile(hist["du"].iloc[-6:].values, (n, 1))
    I0 = {c: hist[f"I_{c}"].iloc[-1] for c in COMPONENTS}
    lev = {c: np.full(n, 1.0) for c in COMPONENTS}
    paths = {c: np.empty((n, h)) for c in COMPONENTS + ["total"]}
    months = [next_ym(origin, k + 1) for k in range(h)]
    tot_prev = np.full(n, 1.0)
    for k in range(h):
        mth = int(months[k][5:7])
        du_all = np.column_stack([du_lag, du[:, :k + 1]]) if k else np.column_stack([du_lag, du[:, :1]])
        du0, du1, du2 = du_all[:, -1], du_all[:, -2], du_all[:, -3]
        du35 = du_all[:, -6:-3].mean(1)
        eps = np.empty((n, len(COMPONENTS)))
        for s in (0, 1):
            idx = np.where(reg[:, k] == s)[0]
            if len(idx):
                R, pw = pools[s]
                eps[idx] = R[rng.choice(len(R), size=len(idx), p=pw)]
        tot_lag1 = lag["total"][:, -1]
        for j, c in enumerate(COMPONENTS):
            L = lag[c]
            X = _features(L[:, -1], L[:, -3:-1].mean(1), tot_lag1, du0, du1, du2, du35,
                          np.full(n, mth), use_fx)
            pi = X @ pm.beta[c] + eps[:, j]
            paths[c][:, k] = pi
            lev[c] = lev[c] * np.exp(pi / 100)
            lag[c] = np.column_stack([L[:, 1:], pi])
        tot = sum(weights[c] * I0[c] * lev[c] for c in COMPONENTS) / sum(weights[c] * I0[c] for c in COMPONENTS)
        paths["total"][:, k] = 100 * np.log(tot / tot_prev)
        tot_prev = tot
        lag["total"] = np.column_stack([lag["total"][:, 1:], paths["total"][:, k]])

    past6 = d.index[d.index.get_loc(origin) - 6] if d.index.get_loc(origin) >= 6 else None
    known6 = {c: 100 * np.log(hist[f"I_{c}"].iloc[-1] / d.loc[past6, f"I_{c}"])
              for c in COMPONENTS + ["total"]}
    f = Forecast(origin, months, paths, du, I0, known6, weights)
    f.level_past6 = {c: d.loc[past6, f"I_{c}"] for c in COMPONENTS}
    f.fx = fx
    return f


# ------------------------------------------------------------------ calibration
MIN_CAL = 24          # past origins needed before recalibration kicks in
CAL_WINDOW = 48       # most recent known origins used for recalibration


def recalibrate(x: np.ndarray, known: pd.DataFrame) -> np.ndarray:
    """Shift and stretch an ensemble using only errors already observed.

    `known` holds past backtest rows (y, median, lo80, hi80).
    bias  = mean past error (outcome - median)
    scale = 80th percentile of |error - bias| / half-width of the 80% interval
    """
    if len(known) < MIN_CAL:
        return x
    err = known.y - known["median"]
    bias = err.mean()
    hw = (known.hi80 - known.lo80) / 2
    k = float(np.quantile((err - bias).abs() / hw, 0.8))
    med = np.median(x)
    return med + bias + k * (x - med)


def known_errors(model: str, target: str, origin: str) -> pd.DataFrame:
    """Backtest rows whose outcome is known at `origin` (from backtest.py)."""
    path = ROOT / "reports" / "backtest_results.csv"
    if not path.exists():
        return pd.DataFrame()
    r = pd.read_csv(path)
    r = r[(r.model == model) & (r.target == target) & (r.origin <= next_ym(origin, -HORIZON))]
    return r.sort_values("origin").tail(CAL_WINDOW)


# ------------------------------------------------------------------ report
QS = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
LOW_INCOME = {"food": 0.45, "housing": 0.25, "other": 0.30}   # assumption, see README


def summarize(x: np.ndarray, qs=QS) -> dict:
    return {f"q{int(q * 100):02d}": float(np.quantile(x, q)) for q in qs}


def log_to_pct(x: np.ndarray) -> np.ndarray:
    return 100 * (np.exp(x / 100) - 1)


def yoy_from_cum(f: Forecast, cum_log: np.ndarray, target: str) -> np.ndarray:
    return 100 * (np.exp((f.known6[target] + cum_log) / 100) - 1)


def run_report(n: int = 20000) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from analyze_data import INK2, SERIES, style

    d, w = load_data()
    origin = d["pi_total"].dropna().index[-1]
    pm_usd = partial_month_usd()
    fx_first, note = None, ""
    if pm_usd and pm_usd[0] == next_ym(origin):
        fx_first = 100 * np.log(pm_usd[1] / d.loc[origin, "usd"])
        note = (f"Month 1 ({pm_usd[0]}) uses the free-USD average observed so far "
                f"({pm_usd[1]:,.0f} rial, {log_to_pct(np.array(fx_first)):+.1f}% vs {origin}).")
    f = forecast(d, w, origin, n=n, fx_first=fx_first)
    end = f.months[-1]
    usd0 = d.loc[origin, "usd"]
    lines = [f"# Inflation forecast, origin {origin} (horizon {f.months[0]} .. {end})\n",
             f"Data: SCI CPI up to {origin}. {note}",
             f"Probability that the FX market is in the crisis regime: {f.fx.p_last[1]:.2f}\n",
             "## Main forecast (FX simulated)\n",
             "| quantity | 5% | 10% | 25% | median | 75% | 90% | 95% |",
             "|---|---|---|---|---|---|---|---|"]
    rows = {}
    for tgt, label in [("total", "headline"), ("food", "food, beverages, tobacco"),
                       ("housing", "housing & utilities"), ("other", "other goods & services")]:
        cum = f.paths[tgt].sum(1)
        rows[f"6-month inflation, {label} (%)"] = log_to_pct(cum)
        rows[f"point-to-point {end}, {label} (%)"] = yoy_from_cum(f, cum, tgt)
    rows[f"point-to-point {end}, low-income basket (%)"] = f.yoy_at_horizon(LOW_INCOME)
    du_cum = f.du.sum(1)
    rows[f"free USD {end} (thousand rial)"] = usd0 * np.exp(du_cum / 100) / 1000
    for k, x in rows.items():
        q = summarize(x)
        lines.append(f"| {k} | " + " | ".join(f"{v:,.0f}" if "USD" in k else f"{v:.1f}" for v in q.values()) + " |")
    yoy = rows[f"point-to-point {end}, headline (%)"]
    lines.append("\nProbability that headline point-to-point inflation in "
                 f"{end} is ...\n")
    lines.append("| below 70% | 70-80% | 80-90% | 90-100% | 100-120% | above 120% |")
    lines.append("|---|---|---|---|---|---|")
    bins = [-np.inf, 70, 80, 90, 100, 120, np.inf]
    h = np.histogram(yoy, bins=bins)[0] / len(yoy)
    lines.append("| " + " | ".join(f"{100 * v:.0f}%" for v in h) + " |")

    # FX scenarios (FX path given), recalibrated with past fx_known errors
    scen = {"deal / rial recovers (-3%/month)": -3.0, "FX flat": 0.0,
            "steady depreciation (+3%/month)": 3.0, "escalation (+8%/month)": 8.0}
    lines += ["\n## Scenarios: FX path fixed, recalibrated intervals\n",
              f"Month 1 FX is the observed {pm_usd[0] if pm_usd else ''} move in every scenario.\n",
              f"| scenario | free USD {end} (k rial) | headline {end} 10% | median | 90% | food median |",
              "|---|---|---|---|---|---|"]
    known = known_errors("fx_known", "total", origin)
    known_food = known_errors("fx_known", "food", origin)
    for name, g in scen.items():
        path = np.r_[fx_first if fx_first is not None else g, np.full(HORIZON - 1, 100 * np.log1p(g / 100))]
        fs = forecast(d, w, origin, n=n // 2, fx_path=path, seed=2)
        cum = recalibrate(fs.paths["total"].sum(1), known)
        cum_food = recalibrate(fs.paths["food"].sum(1), known_food)
        y = yoy_from_cum(fs, cum, "total")
        yf = yoy_from_cum(fs, cum_food, "food")
        usd_end = usd0 * np.exp(path.sum() / 100) / 1000
        q = np.quantile(y, [0.1, 0.5, 0.9])
        lines.append(f"| {name} | {usd_end:,.0f} | {q[0]:.0f}% | {q[1]:.0f}% | {q[2]:.0f}% | {np.median(yf):.0f}% |")
    if known.empty:
        lines.append("\n(no backtest_results.csv yet: scenario intervals are not recalibrated)")

    # fan chart of headline point-to-point inflation, history + forecast
    hist = 100 * (d["I_total"] / d["I_total"].shift(12) - 1)
    hist = hist.dropna().loc[:origin].iloc[-24:]
    known_lv = d["I_total"]
    lv0 = known_lv.loc[origin]
    cum_paths = np.cumsum(f.paths["total"], 1)
    yoy_paths = np.column_stack([
        100 * (lv0 * np.exp(cum_paths[:, k] / 100) / known_lv.loc[next_ym(f.months[k], -12)] - 1)
        for k in range(HORIZON)])
    fig, ax = plt.subplots(figsize=(9, 4.5))
    style(ax, "Headline point-to-point inflation: history and forecast", "%")
    th = np.arange(len(hist))
    tf = np.arange(len(hist) - 1, len(hist) + HORIZON)
    ax.plot(th, hist.values, color=SERIES[0], linewidth=2, label="official (SCI)")
    for (lo, hi), a in [((0.05, 0.95), 0.15), ((0.10, 0.90), 0.22), ((0.25, 0.75), 0.35)]:
        qlo = np.r_[hist.iloc[-1], np.quantile(yoy_paths, lo, 0)]
        qhi = np.r_[hist.iloc[-1], np.quantile(yoy_paths, hi, 0)]
        ax.fill_between(tf, qlo, qhi, color=SERIES[1], alpha=a, linewidth=0,
                        label=f"{int(lo*100)}-{int(hi*100)}%")
    med = np.r_[hist.iloc[-1], np.median(yoy_paths, 0)]
    ax.plot(tf, med, color=SERIES[1], linewidth=2, label="median forecast")
    ax.annotate(f"{med[-1]:.0f}%", (tf[-1], med[-1]), xytext=(4, 0), textcoords="offset points",
                color=INK2, fontsize=9, va="center")
    labels = list(hist.index) + f.months
    ax.set_xticks(range(0, len(labels), 3), labels[::3])
    ax.legend(frameon=False, labelcolor=INK2, fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(ROOT / "reports" / "forecast_fan.png", dpi=150)
    plt.close(fig)

    text = "\n".join(lines) + "\n"
    (ROOT / "reports" / f"forecast_{origin}.md").write_text(text, encoding="utf-8")
    return text


def main() -> None:
    print(run_report())


if __name__ == "__main__":
    main()
