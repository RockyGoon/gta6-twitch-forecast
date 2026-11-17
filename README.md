# GTA VI Twitch CCU Forecast

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
3. For each hour 2–24, takes the pool's **median log-ratio** to hour 1,
   shrunk 10% toward persistence, and a **spread** from the pool's
   disagreement that hour (population std of the log-ratios, widened ×1.2,
   floor 0.12 log units).
4. Forecasts `q_tau = hour1 × exp(median_log_ratio) × exp(z_tau × spread)`,
   rounded to 2 decimals, clamped to [1, 1e9] and non-decreasing.

The ratios and spread are computed at run time from the case file itself,
so the same program adapts to whatever comparables a case carries. In the
final case the pool grows to include the four practice launches (all
console-only, rolling midnight), which are the closest analogues to GTA VI.

## Validation

Leave-one-out cross-validation on the console-only comparables (predict each
launch's hours 2–24 from the rest of the pool): **mean pinball loss ~0.22**,
against ~0.32 for the house persistence baseline on the same launches. The
spread widening (×1.2) and the 10% shrinkage were chosen on that
cross-validation; the loss is flat across the nearby settings (0.216–0.220),
so the model is not tuned to a knife edge.

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
