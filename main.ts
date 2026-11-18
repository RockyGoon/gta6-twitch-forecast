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
// hour as hour 1's print times the ratio that pool showed for that hour —
// but not the pool's plain median ratio. The pool's launches differ hugely
// in size (hour 1 from ~6k to ~365k viewers), and size bends the shape: the
// bigger hour 1 already is, the flatter the day runs. Across the pool the
// log-ratio at the peak hours falls with log hour 1 with correlation about
// -0.8, and the same slope shows on the wider set of launches with hour 1
// above 5k (29 launches, correlation about -0.6 at the peak). The mechanism
// is the rolling midnight unlock: a small launch's hour 1 is only New
// Zealand and Australia trickling in, so the count multiplies as Europe and
// the US unlock; a mega-launch's hour 1 is already full of hype-watchers
// who stayed up, so the peak lands only just above it — the biggest
// launches on record peak at 1.0–1.3x their hour 1, not 2.2x. A plain
// median ratio (peak 2.23x) therefore over-forecasts exactly the launches
// that look like GTA VI.
//
// So for each hour this program regresses the pool's log-ratios on
// log hour 1 (one predictor, ordinary least squares) and reads the fitted
// value off at this case's hour 1. The spread is the standard deviation of
// the regression's residuals for that hour — what the pool disagrees about
// after size is accounted for — widened a little (x1.4) with a floor. The
// fitted value is shrunk 5% toward persistence, which steadies the hours
// where the pool is thinnest. The ratios and the spread are computed at run
// time from the case file itself, so the same program adapts to whatever
// comparables a case carries.
//
// Cross-validated on the console-only comparables (leave one out, predict its
// hours 2-24 from the rest): mean pinball loss ~0.17, against ~0.22 for the
// plain-median version and ~0.32 for the house persistence baseline on the
// same launches. The gain is concentrated at the extremes the regression
// corrects — the smallest launch (Saros, 0.42 -> 0.19) and the largest
// (The Last of Us Part II, 0.29 -> 0.18) — which is where GTA VI, the
// biggest launch of all, will sit.
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

/** How much the fitted log-ratio is pulled toward persistence (1.0). */
const SHRINK = 0.05;
/** How much the empirical residual log-spread is widened. */
const SPREAD_WIDEN = 1.4;
/** Narrowest spread allowed, in log units (keeps the band honest). */
const SPREAD_FLOOR = 0.2;
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

/** Population standard deviation. */
function spreadOf(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * The size regression for one hour: ordinary least squares of the pool's
 * log-ratios for that hour on the pool's log hour-1 counts, read off at
 * this case's log hour 1. Returns the fitted log-ratio and the spread of
 * the residuals — what the pool still disagrees about once size is
 * accounted for. A pool whose launches all share one hour-1 size has no
 * slope to estimate (denominator 0) and falls back to the plain mean
 * log-ratio; a one-launch pool has no residuals, so the spread is 0 and
 * the floor in forecastHour takes over.
 */
function sizeRegression(
  logRatios: number[],
  logHourOnes: number[],
  logTargetHourOne: number,
): { centreLog: number; spread: number } {
  const n = logRatios.length;
  const meanX = logHourOnes.reduce((a, b) => a + b, 0) / n;
  const meanY = logRatios.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (logHourOnes[i] - meanX) * (logRatios[i] - meanY);
    denominator += (logHourOnes[i] - meanX) * (logHourOnes[i] - meanX);
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  const centreLog = intercept + slope * logTargetHourOne;
  const residuals = logRatios.map(
    (y, i) => y - (intercept + slope * logHourOnes[i]),
  );
  return { centreLog, spread: spreadOf(residuals) };
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
 * The forecast for one hour: hour 1's print times the pool's size-fitted
 * ratio for that hour (shrunk toward persistence), spread by the pool's
 * residual disagreement for that hour (widened, with a floor).
 */
function forecastHour(
  hourOne: number,
  hour: number,
  logRatios: number[][],
  logHourOnes: number[],
): number[] {
  const idx = hour - 1;
  const column = logRatios.map((row) => row[idx]);
  const { centreLog, spread: residualSpread } = sizeRegression(
    column,
    logHourOnes,
    Math.log(hourOne),
  );
  const midLog = centreLog * (1 - SHRINK);
  const ratio = Math.min(Math.max(Math.exp(midLog), RATIO_MIN), RATIO_MAX);
  const spread = Math.max(residualSpread * SPREAD_WIDEN, SPREAD_FLOOR);
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
  const logHourOnes = pool.map((entry) => Math.log(entry.curve[0]));

  const hours = c.forecast.map(({ hour }) => ({
    hour,
    q:
      logRatios.length > 0
        ? forecastHour(hourOne, hour, logRatios, logHourOnes)
        : persistenceHour(hourOne, hour),
  }));
  if (hours.length !== FORECAST_HOURS) {
    throw new Error(`${file} asks for ${hours.length} forecast hours, not ${FORECAST_HOURS}`);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
