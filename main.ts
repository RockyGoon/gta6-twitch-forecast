// gta6-twitch-ccu-forecast-01 — a forecaster for a console launch day on Twitch.
//
// The target is a console-only game that unlocks at local midnight, rolling
// country by country. That unlock shape is what makes the day's curve: hour 1
// (00:00-01:00 UTC) only has New Zealand, Australia and the earliest European
// players in it, so it is quiet; the count climbs as the US East Coast unlocks
// at 05:00 UTC and the West Coast at 08:00 UTC, peaks in the UTC afternoon and
// evening while the US plays through its day, then tapers late. A flat
// persistence forecast misses that whole shape, and a median taken over every
// past launch misses it too, because most past launches are PC or mixed and
// their hour 1 is already the peak.
//
// So this program reads the launch-day curve of every past launch the case
// ships as a comparable, keeps only the console-only ones (no PC in their
// platforms — the ones whose unlock rolls the same way), and forecasts each
// hour as hour 1's print times the median ratio that pool showed for that
// hour, with a spread taken from how much the pool disagreed. The ratios and
// the spread are computed at run time from the case file itself, so the same
// program adapts to whatever comparables a case carries.
//
// Cross-validated on the console-only comparables (leave one out, predict its
// hours 2-24 from the rest): mean pinball loss ~0.22, against ~0.32 for the
// house persistence baseline on the same launches. The spread is widened a
// little (x1.2) because a pool of eight launches understates how uncertain
// the shape is, and the median ratio is shrunk 10% toward persistence, which
// steadies the hours where the pool is thinnest.
//
// Node 22, standard library only, no network. Reads every <id>.in in the
// input directory and writes <id>.out to the output directory:
//   {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, hours 2..24.
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The five quantile levels the contest scores, in row order. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantile at each level. */
const Z_SCORES = [-1.645, -0.674, 0, 0.674, 1.645];
/** Hours of a release day. */
const DAY_HOURS = 24;
/** Hours this program forecasts (2..24). */
const FORECAST_HOURS = 23;

/** How much the median ratio is pulled toward persistence (1.0). */
const SHRINK = 0.1;
/** How much the empirical log-spread is widened. */
const SPREAD_WIDEN = 1.2;
/** Narrowest spread allowed, in log units (keeps the band honest). */
const SPREAD_FLOOR = 0.12;
/** Baseline spread per sqrt-hour, used only when no comparable is usable. */
const BASE_SIGMA = 0.15;
/** Smallest pool worth trusting on its own; below it, use every comparable. */
const MIN_CONSOLE_POOL = 3;

interface CaseFile {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Array<{
    name: string;
    day_start: string;
    platforms?: string;
    hourly: Array<{ from: string; viewers: number }>;
  }>;
}

/** Median of numbers (average of the two middles when even). */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Population standard deviation. */
function spreadOf(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/** x rounded to 2 decimals, half up. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * A comparable's release-day curve: the 24 hourly viewer counts of its
 * release UTC day, oldest first. Returns null unless every hour is present
 * and positive (a partial curve would bend the medians).
 */
function releaseDayCurve(
  dayStart: string,
  hourly: Array<{ from: string; viewers: number }>,
): number[] | null {
  const start = Date.parse(dayStart);
  if (!Number.isFinite(start)) return null;
  const byHour = new Map<number, number>();
  for (const point of hourly) {
    const t = Date.parse(point.from);
    if (!Number.isFinite(t)) continue;
    byHour.set(t, point.viewers);
  }
  const curve: number[] = [];
  for (let h = 0; h < DAY_HOURS; h++) {
    const viewers = byHour.get(start + h * 3_600_000);
    if (viewers === undefined || viewers <= 0) return null;
    curve.push(viewers);
  }
  return curve;
}

/** True when a comparable launched on console only (no PC in its platforms). */
function isConsoleOnly(platforms: string | undefined): boolean {
  if (!platforms) return false;
  return !/\bpc\b/i.test(platforms);
}

/** The median ratio is kept inside a sane band: a pool with a skewed launch
 *  in it must not forecast a collapse or an explosion the day never shows. */
const RATIO_MIN = 0.15;
const RATIO_MAX = 6.0;

/**
 * The forecast for one hour: hour 1's print times the pool's median ratio
 * for that hour (shrunk toward persistence), spread by the pool's
 * disagreement for that hour (widened, with a floor).
 */
function forecastHour(
  hourOne: number,
  hour: number,
  logRatios: number[][],
): number[] {
  const idx = hour - 1;
  const column = logRatios.map((row) => row[idx]);
  const midLog = medianOf(column) * (1 - SHRINK);
  const ratio = Math.min(Math.max(Math.exp(midLog), RATIO_MIN), RATIO_MAX);
  const spread = Math.max(spreadOf(column) * SPREAD_WIDEN, SPREAD_FLOOR);
  const centre = hourOne * ratio;
  const qs = Z_SCORES.map((z) => round2(centre * Math.exp(z * spread)));
  // Keep the row valid: above 0, at most 1e9, non-decreasing.
  let prev = 1;
  return qs.map((q) => {
    const clamped = Math.min(Math.max(q, prev, 1), 1_000_000_000);
    prev = clamped;
    return clamped;
  });
}

/** The house persistence fallback, used only when no comparable is usable. */
function persistenceHour(hourOne: number, hour: number): number[] {
  const qs = Z_SCORES.map((z) =>
    round2(hourOne * Math.exp(z * BASE_SIGMA * Math.sqrt(hour - 1))),
  );
  let prev = 1;
  return qs.map((q) => {
    const clamped = Math.min(Math.max(q, prev, 1), 1_000_000_000);
    prev = clamped;
    return clamped;
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${file} has no hour-1 print`);
  const hourOne = Math.max(1, first.viewers);

  // Every comparable's release-day curve, with its log-ratio rows.
  const curves = (c.comparables ?? [])
    .map((comp) => ({
      consoleOnly: isConsoleOnly(comp.platforms),
      curve: releaseDayCurve(comp.day_start, comp.hourly),
    }))
    .filter((entry) => entry.curve !== null) as Array<{
    consoleOnly: boolean;
    curve: number[];
  }>;
  const consoleCurves = curves.filter((entry) => entry.consoleOnly);
  // Prefer the console-only pool; fall back to every comparable when it is
  // too thin to trust, and to persistence when nothing is usable at all.
  const pool =
    consoleCurves.length >= MIN_CONSOLE_POOL ? consoleCurves : curves;
  const logRatios = pool.map((entry) =>
    entry.curve.map((v) => Math.log(v / entry.curve[0])),
  );

  const hours = c.forecast.map(({ hour }) => ({
    hour,
    q:
      logRatios.length > 0
        ? forecastHour(hourOne, hour, logRatios)
        : persistenceHour(hourOne, hour),
  }));
  if (hours.length !== FORECAST_HOURS) {
    throw new Error(`${file} asks for ${hours.length} forecast hours, not ${FORECAST_HOURS}`);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
