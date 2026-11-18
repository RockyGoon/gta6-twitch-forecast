# GTA VI Twitch CCU Forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/RockyGoon/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/RockyGoon/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), as five quantiles an hour, from
everything recorded up to the end of the day's first hour. Entry for the
make.fun bounty **gta6-twitch-ccu-forecast-01** ($250, free entry).

## The model

A console-only game that unlocks at local midnight, rolling country by
country, has a distinctive day shape: hour 1 is quiet (only New Zealand,
Australia and the earliest European players), the count climbs as the US East
Coast unlocks at 05:00 UTC and the West Coast at 08:00 UTC, peaks in the UTC
afternoon and evening while the US plays through its day, then tapers late.
A flat persistence forecast misses that shape, and a median over every past
launch misses it too — most past launches are PC or mixed, and their hour 1
is already the peak.

So the program:

1. Reads every comparable launch the case ships, extracts each one's
   release-day hourly curve (24 hours, all present and positive).
2. Keeps only the console-only ones — no "PC" in their platforms — the
   launches whose unlock rolls the same way. If that pool is thinner than 3,
   it falls back to every usable comparable; if none is usable, to the house
   persistence baseline.
3. For each hour 2–24, regresses the pool's **log-ratios** to hour 1 on
   **log hour 1** (one predictor, ordinary least squares) and reads the
   fitted value off at this case's hour 1 — because the bigger hour 1
   already is, the flatter the day runs (peak-hour correlation about −0.8
   across the pool; the biggest launches on record peak at only 1.0–1.3×
   their hour 1, while the pool median says 2.23×). The fitted log-ratio
   is shrunk 5% toward persistence.
4. Takes the **spread** from the regression's residual disagreement that
   hour (population std of the residuals, widened ×1.4, floor 0.20 log
   units) and forecasts
   `q_tau = hour1 × exp(fitted_log_ratio) × exp(z_tau × spread)`,
   rounded to 2 decimals, clamped to [1, 1e9] and non-decreasing.

The ratios and spread are computed at run time from the case file itself,
so the same program adapts to whatever comparables a case carries. In the
final case the pool grows to include the four practice launches (all
console-only, rolling midnight), which are the closest analogues to GTA VI.

## Validation

Leave-one-out cross-validation on the console-only comparables (predict each
launch's hours 2–24 from the rest of the pool): **mean pinball loss ~0.17**,
against ~0.22 for the plain-median version of this model and ~0.32 for the
house persistence baseline on the same launches. The gain is concentrated
at the size extremes the regression corrects — the smallest launch (Saros,
0.42 → 0.19) and the largest (The Last of Us Part II, 0.29 → 0.18) — and
the size slope is confirmed on the wider set of launches with hour 1 above
5,000 viewers (29 launches: the regression cuts that pool's LOOCV loss from
0.31 to 0.26). On the LOOCV the forecast's 90% band covers 88% of hours
with a typical median miss of ~32% (plain-median version: 41%). The
regression slope, widening (×1.4) and floor (0.20) were chosen on that
cross-validation; the loss is flat across the nearby settings (0.174–0.176),
so the model is not tuned to a knife edge. Alternatives tried and rejected
on the same LOOCV: mean/trimmed-mean/midhinge centres (0.210–0.212),
smoothing the ratio curve across hours (0.215), empirical pool quantiles
instead of normal z-scores (0.227), recency weighting (0.216–0.233),
asymmetric upper/lower spreads (0.214 alone, 0.189 with the regression),
smoothing the regression slope across hours (0.234), and blending the
regression with the median centre (0.185 at 50/50 — the full regression
wins at 0.174).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. Reads every `<id>.in` in the
input directory and writes `<id>.out` (exactly 23 rows, hours 2–24, five
quantiles each) to the output directory. Runs in well under the 8-second,
1-CPU, 1024-MB budget.

## Layout

```
main.ts    the forecaster
LICENSE    MIT
```

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qh87q9q5&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
