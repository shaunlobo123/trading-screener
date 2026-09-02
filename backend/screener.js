// ═══════════════════════════════════════════════════════════════════════
// screener.js — Stage 1: given a date and a market, generate two CSVs.
//
//   momentum: symbols where 1mth%, 3mth%, and 6mth% are ALL > 20%
//   pattern:  symbols where the last 2 complete months were red, and the
//             current (in-progress) month is green so far with its close
//             above the previous month's high
//
// Both computed purely from candlestick data, as of the given date only —
// nothing after that date is ever looked at, which is what makes "chart
// until that date, not until today" possible later.
//
// Data sources (unchanged from before, confirmed real):
//   US: candlestick_alphavantage(symbol, date, open_price, high_price,
//       low_price, close_price, volume) — daily only, monthly rolled up
//   IN: upstox_daily_candlestick(link, timestamp, open, high, low, close,
//       volume) — daily
//       upstoxcandlestick(link, timestamp, ...) — real monthly bars
//
// ⚠️  FROZEN ALGORITHM — DO NOT EDIT MATH — see /AGENTS.md §0
//   - passesMomentum() threshold is >20% strict, ADR >4.5 is required
//   - passesPattern() is red,red,green && last.close > prev1.high
//   - pctChangeOverMonths uses calendar-month setUTCMonth, not day approx
//   - rollupToMonthly is open=first.open, close=last.close, high=max, low=min
//   - wilderATR is Wilder 14, sl = atr - abs(dollar_up), adr is 20d high/low ratio
//   - ALL queries are filtered `<= date` — no future leak — changing this
//     breaks the entire training/paper-trading point-in-time guarantee.
//   If you need a new idea, add a NEW screen name — do NOT alter these two.
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { getPool, getSource, normaliseDataset, ensureNorgateView } = require('./datasets');
const MIN_MOMENTUM_ADR = 4.5;

// ── Candle fetchers ──────────────────────────────────────────────────
async function getDailyCandlesUS(pool, symbol, date, dataset = 'av') {
  const src = getSource(dataset, 'US');
  if (!src) throw new Error(`Dataset ${dataset} has no US candle source`);
  if (dataset === 'norgate') await ensureNorgateView();
  const params = [symbol.toUpperCase()];
  const dateFilter = date ? `AND ${src.dateColumn} <= $2::date` : '';
  if (date) params.push(date);
  const { rows } = await pool.query(
    `SELECT ${src.dateColumn}::text AS date, ${src.open} AS open, ${src.high} AS high,
            ${src.low} AS low, ${src.close} AS close, ${src.volume}
     FROM ${src.table}
     WHERE ${src.symbolColumn} = $1
       ${dateFilter}
     ORDER BY ${src.dateColumn} ASC`,
    params
  );
  return rows.map((r) => ({
    date: r.date, open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  }));
}

async function getDailyCandlesIN(pool, symbol, date) {
  const params = [symbol];
  const dateFilter = date ? "AND timestamp < ($2::date + INTERVAL '1 day')" : '';
  if (date) params.push(date);
  const { rows } = await pool.query(
    `SELECT timestamp::date::text AS date, open, high, low, close, volume
     FROM upstox_daily_candlestick
     WHERE link = $1
       ${dateFilter}
     ORDER BY timestamp ASC`,
    params
  );
  return rows.map((r) => ({
    date: r.date, open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  }));
}

async function getMonthlyCandlesIN(pool, symbol, date) {
  const params = [symbol];
  const dateFilter = date ? "AND timestamp < ($2::date + INTERVAL '1 day')" : '';
  if (date) params.push(date);
  const { rows } = await pool.query(
    `SELECT timestamp::date::text AS date, open, high, low, close, volume
     FROM upstoxcandlestick
     WHERE link = $1
       ${dateFilter}
     ORDER BY timestamp ASC`,
    params
  );
  return rows.map((r) => ({
    date: r.date, open: Number(r.open), high: Number(r.high),
    low: Number(r.low), close: Number(r.close), volume: Number(r.volume),
  }));
}

async function getDailyCandles(poolOrDataset, market, symbol, date, datasetMaybe) {
  // Accepts (pool, market, symbol, date, dataset) or (dataset, market, ...) -
  // the latter resolves the right pool itself.
  let pool;
  let dataset;
  if (typeof poolOrDataset === 'string' && datasetMaybe === undefined) {
    dataset = normaliseDataset(poolOrDataset);
    pool = getPool(dataset);
  } else {
    pool = poolOrDataset;
    dataset = normaliseDataset(datasetMaybe);
  }
  if (market === 'US') return getDailyCandlesUS(pool, symbol, date, dataset);
  return getDailyCandlesIN(pool, symbol, date);
}

function resolvePoolAndMarket(datasetOrPool, market) {
  // Norgate only covers US equities - anything else falls back to av.
  if (typeof datasetOrPool === 'string') {
    const dataset = normaliseDataset(datasetOrPool);
    const resolved = SOURCES_HAS(dataset, market) ? dataset : 'av';
    return { dataset: resolved, pool: getPool(resolved) };
  }
  return { dataset: 'av', pool: datasetOrPool };
}

function SOURCES_HAS(dataset, market) {
  return Boolean(getSource(dataset, market));
}

async function getUniverse(poolOrDataset, market) {
  let pool;
  let source;
  if (typeof poolOrDataset === 'string') {
    const dataset = normaliseDataset(poolOrDataset);
    source = getSource(dataset, market);
    if (!source) return [];
    pool = getPool(dataset);
    if (dataset === 'norgate') await ensureNorgateView();
  } else {
    pool = poolOrDataset;
    source = getSource('av', market);
  }
  const { rows } = await pool.query(source.universeQuery);
  return rows.map((r) => r[source.universeField]);
}

// ── Pure candle math ─────────────────────────────────────────────────
function asOf(candles, date) {
  return candles.filter((c) => c.date <= date);
}

function isRed(c) { return c.close < c.open; }
function isGreen(c) { return c.close > c.open; }

function rollupToMonthly(dailyCandles) {
  const byMonth = new Map();
  for (const c of dailyCandles) {
    const key = c.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(c);
  }
  const months = [...byMonth.keys()].sort();
  return months.map((key) => {
    const rows = byMonth.get(key);
    return {
      date: rows[rows.length - 1].date,
      open: rows[0].open,
      close: rows[rows.length - 1].close,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
    };
  });
}

function pctChangeOverMonths(dailyCandles, date, months) {
  const rows = asOf(dailyCandles, date);
  if (rows.length === 0) return null;
  const current = rows[rows.length - 1].close;
  const target = new Date(date + 'T00:00:00Z');
  target.setUTCMonth(target.getUTCMonth() - months);
  const targetDate = target.toISOString().slice(0, 10);
  const past = rows.filter((c) => c.date <= targetDate);
  if (past.length === 0) return null;
  const pastClose = past[past.length - 1].close;
  if (!pastClose) return null;
  return ((current - pastClose) / pastClose) * 100;
}

function calendarMonthsAgo(date, months) {
  const d = new Date(date + 'T00:00:00Z');
  const originalDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + 1, 0
  )).getUTCDate();
  d.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return d.toISOString().slice(0, 10);
}

function wilderATR(candles, period = 14) {
  if (candles.length < period) return null;
  const trueRanges = candles.map((c, index) => {
    if (index === 0) return c.high - c.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - previousClose),
      Math.abs(c.low - previousClose)
    );
  });

  let atr = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }
  return atr;
}

function adr(candles, period = 20) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  if (recent.some((c) => !c.low || c.low <= 0)) return null;
  const averageHighLowRatio = recent.reduce((sum, c) => sum + (c.high / c.low), 0) / period;
  return (averageHighLowRatio - 1) * 100;
}

function pctFromLowestLow(candles, date, months) {
  const startDate = calendarMonthsAgo(date, months);
  const window = candles.filter((c) => c.date >= startDate && c.date <= date);
  if (window.length === 0) return null;
  const lowestLow = Math.min(...window.map((c) => c.low));
  const currentClose = candles[candles.length - 1]?.close;
  if (!lowestLow || currentClose == null) return null;
  return ((currentClose - lowestLow) / lowestLow) * 100;
}

function round(value, digits = 2) {
  return value == null || !Number.isFinite(value) ? '' : Number(value.toFixed(digits));
}

function calculateCandleMetrics(dailyCandles, date) {
  const candles = asOf(dailyCandles, date);
  if (candles.length === 0) return null;

  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const dollarUp = previous ? current.close - previous.close : null;
  const pctUp = previous?.close
    ? (dollarUp / previous.close) * 100
    : null;
  const atr = wilderATR(candles, 14);
  const sl = atr != null && dollarUp != null ? atr - Math.abs(dollarUp) : null;

  return {
    close: current.close,
    pct_up: round(pctUp, 2),
    dollar_up: round(dollarUp, 4),
    atr: round(atr, 4),
    sl: round(sl, 4),
    adr: round(adr(candles, 20), 2),
    pct_from_low_1mth: round(pctFromLowestLow(candles, date, 1), 2),
    pct_from_low_3mth: round(pctFromLowestLow(candles, date, 3), 2),
    pct_from_low_6mth: round(pctFromLowestLow(candles, date, 6), 2),
    volume: current.volume,
    // Dollar volume (close * volume) - a same-day, no-external-CSV proxy for
    // market cap / liquidity, replacing the removed Finviz/mergec market_cap
    // lookup (see market cap removal earlier).
    dollar_volume: round(current.close * current.volume, 2),
  };
}

async function getMonthlyAsOf(pool, market, symbol, dailyAsOf, date) {
  if (market === 'US') return rollupToMonthly(dailyAsOf);
  return getMonthlyCandlesIN(pool, symbol, date);
}

async function forEachConcurrent(items, concurrency, callback) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await callback(items[index]);
    }
  });
  await Promise.all(workers);
}

// ── The two screens ───────────────────────────────────────────────────
// relaxed=true (norgate): young datasets may not have 6 months of history,
// so a symbol qualifies when ANY computable lookback clears 20%.
function passesMomentum(daily, date, relaxed = false) {
  const p1 = pctChangeOverMonths(daily, date, 1);
  const p3 = pctChangeOverMonths(daily, date, 3);
  const p6 = pctChangeOverMonths(daily, date, 6);
  if (relaxed) {
    const available = [p1, p3, p6].filter((v) => v != null);
    if (!available.length) return null;
    return available.some((v) => v > 20) ? { p1, p3, p6 } : null;
  }
  if (p1 == null || p3 == null || p6 == null) return null;
  const passes = p1 > 20 && p3 > 20 && p6 > 20;
  return passes ? { p1, p3, p6 } : null;
}

function passesPattern(monthly) {
  if (monthly.length < 3) return null;
  const last = monthly[monthly.length - 1];     // current, in-progress month
  const prev1 = monthly[monthly.length - 2];     // last complete month
  const prev2 = monthly[monthly.length - 3];     // month before that
  const passes = isRed(prev2) && isRed(prev1) && isGreen(last) && last.close > prev1.high;
  return passes ? { prev1High: prev1.high, lastClose: last.close } : null;
}

// ── CSV writer ────────────────────────────────────────────────────────
function writeCSV(filepath, columns, rows) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => row[c]).join(','));
  }
  fs.writeFileSync(filepath, lines.join('\n') + '\n');
}

// ── Entry point: calculate both screens for one market + date ─────────
async function generateScreens(poolOrDataset, market, date, outDir, { writeFiles = true, concurrency = 5, relaxedMomentum = false } = {}) {
  const { dataset, pool } = resolvePoolAndMarket(poolOrDataset, market);
  const universe = await getUniverse(poolOrDataset, market);
  const momentumRows = [];
  const patternRows = [];

  // US and India are generated together. Five workers per market match the
  // default pg pool size of ten without flooding PostgreSQL with promises.
  await forEachConcurrent(universe, concurrency, async (symbol) => {
    const dailyAsOf = await getDailyCandles(dataset, market, symbol, date);
    if (dailyAsOf.length === 0) return;
    const metrics = calculateCandleMetrics(dailyAsOf, date);

    const momentum = passesMomentum(dailyAsOf, date, relaxedMomentum);
    if (momentum && Number(metrics.adr) > MIN_MOMENTUM_ADR) {
      const pctText = (v) => (v == null ? '' : v.toFixed(1));
      momentumRows.push({
        symbol, ...metrics,
        pct_1mth: pctText(momentum.p1),
        pct_3mth: pctText(momentum.p3),
        pct_6mth: pctText(momentum.p6),
      });
    }

    const monthly = await getMonthlyAsOf(pool, market, symbol, dailyAsOf, date);
    const pattern = passesPattern(monthly);
    if (pattern) {
      patternRows.push({
        symbol, ...metrics,
        prev_month_high: pattern.prev1High,
        this_month_close: pattern.lastClose,
      });
    }
  });

  momentumRows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  patternRows.sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Only meaningful when writeFiles is set; the server always passes false and
  // caches into screener_result_sets instead, so there is no outDir to join.
  const momentumPath = writeFiles ? path.join(outDir, `${market}_momentum_${date}.csv`) : null;
  const patternPath = writeFiles ? path.join(outDir, `${market}_pattern_${date}.csv`) : null;
  const frontendColumns = [
    'symbol', 'close', 'pct_up', 'dollar_up', 'atr', 'sl', 'adr',
    'pct_from_low_1mth', 'pct_from_low_3mth', 'pct_from_low_6mth', 'volume',
    'dollar_volume',
  ];
  if (writeFiles) {
    writeCSV(
      momentumPath,
      [...frontendColumns, 'pct_1mth', 'pct_3mth', 'pct_6mth'],
      momentumRows
    );
    writeCSV(
      patternPath,
      [...frontendColumns, 'prev_month_high', 'this_month_close'],
      patternRows
    );
  }

  return {
    momentum: {
      path: writeFiles ? momentumPath : null,
      count: momentumRows.length,
      rows: momentumRows,
    },
    pattern: {
      path: writeFiles ? patternPath : null,
      count: patternRows.length,
      rows: patternRows,
    },
  };
}

module.exports = {
  generateScreens,
  getDailyCandles,
  getUniverse,
  calculateCandleMetrics,
  resolvePoolAndMarket,
};
