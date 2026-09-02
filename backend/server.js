require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { generateScreens } = require('./screener');
const { registerPaperTradingRoutes } = require('./paperTrading');
const { normaliseDataset, getPool, getFinvizIntradayPool, getSource, ensureNorgateView } = require('./datasets');
const {
  authenticate,
  registerProtectedAuthRoutes,
  registerPublicAuthRoutes,
} = require('./auth');
const { registerFinvizDataRoutes, intradayCandle } = require('./finvizData');
const pgFeeds = require('./pgFeeds');
const { GROUP_NAMES } = require('./finvizData');

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

const CHART_RENDER_URL = process.env.CHART_RENDER_URL || 'http://chart-service:4090';

const app = express();
// Mobile (Expo Go) needs CORS + large LAN access. Allow all origins for training instance.
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());
registerPublicAuthRoutes(app, pool);
app.use('/api', authenticate(pool));
registerProtectedAuthRoutes(app, pool);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
registerFinvizDataRoutes(app, pool, DATE_RE);
// ⚠️ FROZEN: ADR threshold for momentum — must match screener.js MIN_MOMENTUM_ADR — see AGENTS.md §0
const MIN_MOMENTUM_ADR = 4.5;
const generationJobs = new Map();
let resultTableReady;

function ensureResultTable(dataset = 'av') {
  const key = normaliseDataset(dataset);
  if (!resultTableReady) {
    resultTableReady = {};
  }
  if (!resultTableReady[key]) {
    resultTableReady[key] = pool.query(`
      CREATE TABLE IF NOT EXISTS screener_result_sets (
        screen_date DATE NOT NULL,
        market TEXT NOT NULL CHECK (market IN ('US', 'IN')),
        screen TEXT NOT NULL CHECK (screen IN ('momentum', 'pattern')),
        rows JSONB NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE screener_result_sets ADD COLUMN IF NOT EXISTS dataset TEXT NOT NULL DEFAULT 'av';
      ALTER TABLE screener_result_sets DROP CONSTRAINT IF EXISTS screener_result_sets_pkey;
      ALTER TABLE screener_result_sets ADD PRIMARY KEY (dataset, screen_date, market, screen);
    `, []).then(() => {}).catch((error) => {
      resultTableReady[key] = null;
      throw error;
    });
  }
  return resultTableReady;
}

function withCurrentSl(rows) {
  return rows.map((row) => {
    if (row.atr == null || row.atr === '' || row.dollar_up == null || row.dollar_up === '') return row;
    const atr = Number(row.atr);
    const dollarUp = Number(row.dollar_up);
    if (!Number.isFinite(atr) || !Number.isFinite(dollarUp)) return row;
    return { ...row, sl: Math.round((atr - dollarUp) * 10000) / 10000 };
  });
}

function filterScreenRows(rows, market, screen) {
  if (market !== 'US') return rows;
  return rows.reduce((filtered, row) => {
    if (screen === 'momentum' && Number(row.adr) <= MIN_MOMENTUM_ADR) return filtered;
    filtered.push(row);
    return filtered;
  }, []);
}

function isValidScreenRequest(market, screen, date) {
  return ['US', 'IN'].includes(market)
    && ['momentum', 'pattern'].includes(screen)
    && DATE_RE.test(date);
}

function rollupCandlesToMonthly(dailyCandles) {
  const months = new Map();
  for (const candle of dailyCandles) {
    const key = candle.time.slice(0, 7);
    const existing = months.get(key);
    if (!existing) {
      months.set(key, {
        time: `${key}-01`,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
  }
  return [...months.values()];
}

async function finvizSnapshotCandle(symbol, tradeDate) {
  try {
    const { rows } = await getFinvizIntradayPool().query(`
      WITH session_snapshots AS (
        SELECT captured_at, price, change_from_open_pct
        FROM finviz_intraday_snapshots
        WHERE symbol = $1
          AND trade_date = $2::date
          AND captured_at >= (($2::date + TIME '09:30') AT TIME ZONE 'America/New_York')
          AND captured_at <= (($2::date + TIME '16:00') AT TIME ZONE 'America/New_York')
      ), first_snapshot AS (
        SELECT captured_at, price, change_from_open_pct
        FROM session_snapshots
        ORDER BY captured_at ASC
        LIMIT 1
      ), summary AS (
        SELECT MIN(price) AS low, MAX(price) AS high
        FROM session_snapshots
      ), last_snapshot AS (
        SELECT price AS close
        FROM session_snapshots
        ORDER BY captured_at DESC
        LIMIT 1
      )
      SELECT first_snapshot.captured_at <= (($2::date + TIME '09:32') AT TIME ZONE 'America/New_York') AS has_open_coverage,
             first_snapshot.price AS first_price,
             first_snapshot.change_from_open_pct,
             summary.low, summary.high, last_snapshot.close
      FROM first_snapshot
      CROSS JOIN summary
      CROSS JOIN last_snapshot
    `, [String(symbol).toUpperCase(), tradeDate]);
    const row = rows[0];
    const firstPrice = Number(row?.first_price);
    const changeFromOpen = Number(row?.change_from_open_pct);
    const low = Number(row?.low);
    const high = Number(row?.high);
    const close = Number(row?.close);
    const open = firstPrice / (1 + changeFromOpen / 100);
    if (!row?.has_open_coverage || !Number.isFinite(open) || open <= 0
        || ![low, high, close].every(Number.isFinite)) return null;
    return {
      time: tradeDate,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: 0,
      temporary: true,
      source: 'finviz-intraday-snapshots',
    };
  } catch (error) {
    // The snapshot database/table does not exist until the first scheduled
    // collector runs. A chart should continue to show official daily bars.
    if (['3D000', '42P01'].includes(error.code)) return null;
    throw error;
  }
}

async function ibeamLiveCandle(symbol, tradeDate) {
  try {
    const { rows } = await getFinvizIntradayPool().query(`
      SELECT open_price AS open, high_price AS high, low_price AS low, close_price AS close
      FROM ibeam_live_daily_bars
      WHERE symbol = $1
        AND trade_date = $2::date
        AND fetched_at >= NOW() - INTERVAL '15 minutes'
      LIMIT 1
    `, [String(symbol).toUpperCase(), tradeDate]);
    const row = rows[0];
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    if (![open, high, low, close].every(Number.isFinite) || open <= 0) return null;
    return {
      time: tradeDate,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      // This is a temporary visual candle. Do not show partial-day volume.
      volume: 0,
      temporary: true,
      source: 'ibeam-live-daily',
    };
  } catch (error) {
    // The IBeam collector has not created its table until its first successful run.
    if (['3D000', '42P01'].includes(error.code)) return null;
    throw error;
  }
}

async function loadCandles(market, symbol, date, period, dataset = 'av', includeLiveCandle = false,
                           fullHistory = false, reviewEnd = '', reviewStart = '') {
  const activeDataset = normaliseDataset(dataset);
  const candlePool = getPool(activeDataset);
  const liveCandle = includeLiveCandle && market === 'US' && activeDataset === 'av'
    ? intradayCandle(symbol)
    : null;
  // A live screener list can lag the current session. Query through the
  // Finviz session date so its current candle has a proper historical run-up.
  let chartEndDate = liveCandle?.time || date;
  // Reviewing a closed trade: the chart ends ON the exit, whichever side of the
  // selected date that falls.
  //   - exit later than the selected date  -> extend forward, so going back to
  //     the entry day to study the setup still loads the closing candle.
  //   - exit earlier (the usual case in training, where the session has moved
  //     on)                                -> pull back, so the review shows the
  //     trade and stops, instead of running on to the current training date
  //     with candles that were never part of it.
  if (fullHistory && reviewEnd) chartEndDate = reviewEnd;
  const rowsToCandles = (rows) => rows.map((row) => ({
    time: row.time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }));

  if (market === 'IN' && period === 'monthly') {
    const [completedMonths, selectedMonthDays] = await Promise.all([
      pool.query(
        `SELECT (timestamp AT TIME ZONE 'Asia/Kolkata')::date::text AS time,
                open, high, low, close, volume
         FROM upstoxcandlestick
         WHERE link = $1
           AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date
               < date_trunc('month', $2::date)::date
         ORDER BY timestamp ASC`,
        [symbol, chartEndDate]
      ),
      pool.query(
        `SELECT (timestamp AT TIME ZONE 'Asia/Kolkata')::date::text AS time,
                open, high, low, close, volume
         FROM upstox_daily_candlestick
         WHERE link = $1
           AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date
               >= date_trunc('month', $2::date)::date
           AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
         ORDER BY timestamp ASC`,
        [symbol, chartEndDate]
      ),
    ]);
    const nativeCandles = rowsToCandles(completedMonths.rows);
    const partialMonth = rollupCandlesToMonthly(rowsToCandles(selectedMonthDays.rows));
    return [...nativeCandles, ...partialMonth];
  }

  // Daily chart floor.
  //
  //  - normal trading: 1 year (IN) / 5 months (US), measured back from the
  //    selected date, to keep the view tight.
  //  - reviewing a closed trade: measured back from the ENTRY instead, so the
  //    chart opens on the setup that led to the buy. Anchoring to the selected
  //    date is wrong here, because reviewing from the entry day would then cut
  //    the run-up short, and dropping the floor altogether starts the chart at
  //    the beginning of the dataset - months of irrelevant history squeezing
  //    the part being reviewed into the right-hand edge.
  //
  // REVIEW_LEAD_IN is how much context to show before the buy.
  const REVIEW_LEAD_IN = '3 months';
  const reviewFloor = fullHistory && reviewStart;
  const dailyFloor = (column, defaultInterval) => {
    if (period !== 'daily') return '';
    if (reviewFloor) return ` AND ${column} > $3::date - INTERVAL '${REVIEW_LEAD_IN}'`;
    if (fullHistory) return '';
    return ` AND ${column} > $2::date - INTERVAL '${defaultInterval}'`;
  };
  const dateWindow = dailyFloor('timestamp::date', '1 year');
  let query;
  if (market === 'US') {
    const source = getSource(activeDataset, 'US');
    if (!source) throw new Error(`Dataset ${activeDataset} has no US candle source`);
    if (activeDataset === 'norgate') await ensureNorgateView();
    const usDateWindow = dailyFloor(source.dateColumn, '5 months');
    query = `SELECT ${source.dateColumn}::text AS time, ${source.open} AS open,
                    ${source.high} AS high, ${source.low} AS low,
                    ${source.close} AS close, ${source.volume} AS volume
             FROM ${source.table}
             WHERE ${source.symbolColumn} = $1
               AND ${source.dateColumn} <= $2::date${usDateWindow}
             ORDER BY ${source.dateColumn} ASC`;
  } else {
    query = `SELECT timestamp::date::text AS time, open, high, low, close, volume
             FROM upstox_daily_candlestick
             WHERE link = $1 AND timestamp::date <= $2::date${dateWindow}
             ORDER BY timestamp ASC`;
  }
  const queryParams = [market === 'US' ? symbol.toUpperCase() : symbol, chartEndDate];
  if (reviewFloor) queryParams.push(reviewStart);
  const { rows } = await candlePool.query(query, queryParams);
  let candles = rowsToCandles(rows);
  // IBeam has priority because it supplies the genuine daily OHLC. A complete
  // Finviz session comes next. If collection started late (or resumed after an
  // outage), still show its partial Finviz candle rather than hiding today
  // altogether. It is intentionally marked temporary and has zero volume.
  if (includeLiveCandle && market === 'US' && activeDataset === 'av') {
    const temporaryCandle = await ibeamLiveCandle(symbol, chartEndDate)
      || await finvizSnapshotCandle(symbol, chartEndDate)
      || liveCandle;
    if (temporaryCandle) {
      // Replace any stale daily row for today, never duplicate the date.
      candles = [...candles.filter((candle) => candle.time !== temporaryCandle.time), temporaryCandle];
    }
  }
  return market === 'US' && period === 'monthly' ? rollupCandlesToMonthly(candles) : candles;
}

async function renderChartDirectorSvg(candles) {
  const response = await fetch(`${CHART_RENDER_URL}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candles: candles.map((c) => ({
        date: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Chart renderer failed');
  return body; // { svg, plot: { left, top, width, height, minPrice, maxPrice, count } }
}

// Dates already cached in Postgres, plus legacy CSV dates during migration.
app.get('/api/screener/dates', async (req, res) => {
  try {
    const dates = new Set();
    const dataset = normaliseDataset(req.query.dataset);
    await ensureResultTable(dataset);
    // screener_result_sets has some corrupted screen_date rows (junk years
    // like 0002/0020/0202, and a run of future dates duplicating one
    // pattern-screen result forward by a month at a time) — excluded here
    // rather than fixed at the source, since that's data cleanup, not a
    // query concern. Bounding to a sane historical window keeps the date
    // picker from ever offering one of these as a default or an option.
    const today = new Date().toISOString().slice(0, 10);
    const cached = await pool.query(
      `SELECT DISTINCT screen_date::text AS date
       FROM screener_result_sets
       WHERE dataset = $2 AND screen_date <= $1::date AND screen_date >= '2020-01-01'
       ORDER BY date DESC`,
      [today, dataset]
    );
    cached.rows.forEach((row) => dates.add(row.date));
    res.json([...dates].sort().reverse());
  } catch (err) {
    console.error('screener dates failed:', err);
    res.status(500).json({ error: 'Unable to list generated dates' });
  }
});

// Read a cached Postgres result set; legacy CSVs remain a read-only fallback.
app.get('/api/screener/results/:market/:screen/:date', async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  const screen = String(req.params.screen).toLowerCase();
  const { date } = req.params;
  const dataset = normaliseDataset(req.query.dataset);
  if (!isValidScreenRequest(market, screen, date)) {
    return res.status(400).json({ error: 'Invalid market, screen, or date' });
  }
  if (dataset === 'norgate' && market !== 'US') {
    return res.status(400).json({ error: 'Norgate training covers US equities only' });
  }
  try {
    await ensureResultTable(dataset);
    const cached = await pool.query(
      `SELECT rows, generated_at
       FROM screener_result_sets
       WHERE screen_date = $1::date AND market = $2 AND screen = $3 AND dataset = $4`,
      [date, market, screen, dataset]
    );
    if (cached.rows.length) {
      const rows = filterScreenRows(withCurrentSl(cached.rows[0].rows), market, screen);
      return res.json({
        market,
        screen,
        date,
        count: rows.length,
        rows,
        source: 'postgres',
        generatedAt: cached.rows[0].generated_at,
      });
    }
    return res.status(404).json({ error: `No ${market} ${screen} results for ${date}` });
  } catch (err) {
    console.error('screener results failed:', err);
    res.status(500).json({ error: 'Unable to read generated results' });
  }
});

async function calculateAndCacheDate(date, dataset = 'av') {
  const jobKey = `${dataset}:${date}`;
  if (generationJobs.has(jobKey)) return generationJobs.get(jobKey);

  const job = (async () => {
    await ensureResultTable(dataset);
    const [US, IN] = await Promise.all([
      generateScreens(dataset === 'norgate' ? 'norgate' : pool, 'US', date, null,
        { writeFiles: false, relaxedMomentum: dataset === 'norgate' }),
      dataset === 'norgate' ? Promise.resolve({ momentum: { count: 0, rows: [] }, pattern: { count: 0, rows: [] } })
                            : generateScreens(pool, 'IN', date, null, { writeFiles: false }),
    ]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [market, result] of Object.entries({ US, IN })) {
        for (const screen of ['momentum', 'pattern']) {
          // A transient failure (pool/view race) must not poison the cache:
          // never overwrite non-empty rows with an empty set.
          await client.query(
            `INSERT INTO screener_result_sets
               (dataset, screen_date, market, screen, rows, generated_at)
             VALUES ($5, $1::date, $2, $3, $4::jsonb, NOW())
             ON CONFLICT (dataset, screen_date, market, screen)
             DO UPDATE SET rows = EXCLUDED.rows, generated_at = NOW()
             WHERE jsonb_array_length(EXCLUDED.rows) > 0`,
            [date, market, screen, JSON.stringify(result[screen].rows), dataset]
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      US: {
        momentum: { count: US.momentum.count },
        pattern: { count: US.pattern.count },
      },
      IN: {
        momentum: { count: IN.momentum.count },
        pattern: { count: IN.pattern.count },
      },
    };
  })();

  generationJobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    generationJobs.delete(jobKey);
  }
}

// Raw OHLCV from Postgres, capped at the requested date. This deliberately
// does not call either of the existing PNG/interactive chart services.
// Symbol search over the candle universe (both markets) - lets the live
// screener find and select tickers that are not in the current finviz list.
app.get('/api/screener/symbol-search', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const query = String(req.query.q || '').trim().toUpperCase();
  const limit = Math.min(15, Math.max(1, Number(req.query.limit) || 10));
  const dataset = normaliseDataset(req.query.dataset);
  if (!/^[A-Z0-9.&^-]{1,12}$/.test(query)) return res.json({ symbols: [] });
  try {
    let rows;
    if (dataset === 'norgate') {
      await ensureNorgateView();
      ({ rows } = await getPool(dataset).query(
        `SELECT DISTINCT symbol FROM norgate.us_trainable_daily
         WHERE symbol LIKE $1 AND symbol !~ '[^A-Za-z0-9]'
         ORDER BY symbol LIMIT $2`,
        [`${query}%`, limit]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT symbol FROM candlestick_alphavantage
         WHERE symbol LIKE $1
         GROUP BY symbol ORDER BY symbol LIMIT $2`,
        [`${query}%`, limit]
      ));
    }
    res.json({ symbols: rows.map((row) => row.symbol) });
  } catch (err) {
    console.error('symbol search failed:', err);
    res.status(500).json({ error: 'Unable to search symbols' });
  }
});

app.get('/api/screener/candles/:market/:symbol', async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  const symbol = String(req.params.symbol);
  const date = String(req.query.date || '');
  const period = String(req.query.period || 'daily').toLowerCase();
  const dataset = normaliseDataset(req.query.dataset);
  const live = req.query.live === '1';
  // Set by the frontend only while a closed trade is being reviewed.
  const fullHistory = req.query.full === '1';
  // Latest exit date of the trade under review; ignored unless it parses.
  const reviewEnd = DATE_RE.test(String(req.query.reviewEnd || '')) ? String(req.query.reviewEnd) : '';
  // Entry date of the trade under review; the chart floor is measured from it.
  const reviewStart = DATE_RE.test(String(req.query.reviewStart || '')) ? String(req.query.reviewStart) : '';
  if (!['US', 'IN'].includes(market) || !DATE_RE.test(date) || !['daily', 'monthly'].includes(period)) {
    return res.status(400).json({ error: 'market, date, or period is invalid' });
  }

  try {
    const candles = await loadCandles(market, symbol, date, period, dataset, live, fullHistory, reviewEnd, reviewStart);
    res.json({ market, symbol, date, period, candles });
  } catch (err) {
    console.error('screener candles failed:', err);
    res.status(500).json({ error: 'Unable to load candle data' });
  }
});

// ChartDirector Java trial renderer. Unlike the legacy endpoint below, this
// returns responsive SVG generated from the same historical candle query as
// the interactive chart.
app.get('/api/screener/chartdirector-chart/:market/:symbol', async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  const symbol = String(req.params.symbol);
  const date = String(req.query.date || '');
  const period = String(req.query.period || 'daily').toLowerCase();
  const dataset = normaliseDataset(req.query.dataset);
  const live = req.query.live === '1';
  const fullHistory = req.query.full === '1';
  const reviewEnd = DATE_RE.test(String(req.query.reviewEnd || '')) ? String(req.query.reviewEnd) : '';
  // Entry date of the trade under review; the chart floor is measured from it.
  const reviewStart = DATE_RE.test(String(req.query.reviewStart || '')) ? String(req.query.reviewStart) : '';
  if (!['US', 'IN'].includes(market) || !symbol || !DATE_RE.test(date)
      || !['daily', 'monthly'].includes(period)) {
    return res.status(400).json({ error: 'market, symbol, date, or period is invalid' });
  }

  try {
    const candles = await loadCandles(market, symbol, date, period, dataset, live, fullHistory, reviewEnd, reviewStart);
    if (!candles.length) return res.status(404).json({ error: 'No candle data is available' });
    const { svg, plot } = await renderChartDirectorSvg(candles);
    res.set('Cache-Control', 'no-store');
    res.json({ svg, plot, candles });
  } catch (err) {
    console.error('ChartDirector Java render failed:', err);
    res.status(502).json({ error: 'Unable to render ChartDirector chart' });
  }
});

// Navigate by actual candle dates so the UI does not generate redundant
// weekend/holiday snapshots when the user clicks the date arrows.
app.get('/api/screener/trading-date/:market/earliest', async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  if (!['US', 'IN'].includes(market)) {
    return res.status(400).json({ error: 'market is invalid' });
  }
  // A handful of stale/outlier symbols have much older history than the
  // market dataset as a whole. Use the first-date point reached by 10% of
  // that market's symbols so the practice start reflects real coverage.
  const dataset = normaliseDataset(req.query.dataset);
  if (dataset === 'norgate' && market !== 'US') {
    return res.status(400).json({ error: 'Norgate covers US equities only' });
  }
  let query;
  let queryPool = pool;
  if (dataset === 'norgate') {
    query = `WITH first_dates AS (
         SELECT symbol, MIN(trade_date)::date AS first_date
         FROM norgate.us_trainable_daily
         WHERE symbol !~ '[^A-Za-z0-9]'
         GROUP BY symbol
       )
       SELECT PERCENTILE_DISC(0.10) WITHIN GROUP (ORDER BY first_date)::text AS date
       FROM first_dates`;
    queryPool = getPool(dataset);
    await ensureNorgateView();
  } else {
    query = market === 'US'
      ? `WITH first_dates AS (
           SELECT symbol, MIN(date)::date AS first_date
           FROM candlestick_alphavantage
           GROUP BY symbol
         )
         SELECT PERCENTILE_DISC(0.10) WITHIN GROUP (ORDER BY first_date)::text AS date
         FROM first_dates`
      : `WITH first_dates AS (
           SELECT link, MIN(timestamp)::date AS first_date
           FROM upstox_daily_candlestick
           GROUP BY link
         )
         SELECT PERCENTILE_DISC(0.10) WITHIN GROUP (ORDER BY first_date)::text AS date
         FROM first_dates`;
  }
  try {
    const { rows } = await queryPool.query(query);
    if (!rows[0]?.date) return res.status(404).json({ error: 'No daily candle date is available' });
    res.json({ market, date: rows[0].date });
  } catch (err) {
    console.error('earliest trading date lookup failed:', err);
    res.status(500).json({ error: 'Unable to find the earliest daily candle date' });
  }
});

app.get('/api/screener/trading-date/:market/:direction/:date', async (req, res) => {
  const market = String(req.params.market).toUpperCase();
  const direction = String(req.params.direction).toLowerCase();
  const date = String(req.params.date);
  if (!['US', 'IN'].includes(market) || !['next', 'previous'].includes(direction) || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'market, direction, or date is invalid' });
  }
  const aggregate = direction === 'next' ? 'MIN' : 'MAX';
  const operator = direction === 'next' ? '>' : '<';
  const dataset = normaliseDataset(req.query.dataset);
  if (dataset === 'norgate' && market !== 'US') {
    return res.status(400).json({ error: 'Norgate covers US equities only' });
  }
  let query;
  let queryPool = pool;
  if (dataset === 'norgate') {
    query = `SELECT ${aggregate}(trade_date)::text AS date
             FROM norgate.us_trainable_daily
             WHERE trade_date ${operator} $1::date AND symbol !~ '[^A-Za-z0-9]'`;
    queryPool = getPool(dataset);
    await ensureNorgateView();
  } else if (market === 'US') {
    query = `SELECT ${aggregate}(date)::text AS date
             FROM candlestick_alphavantage WHERE date ${operator} $1::date`;
  } else if (direction === 'next') {
    query = `SELECT MIN(timestamp)::date::text AS date
             FROM upstox_daily_candlestick
             WHERE timestamp >= ($1::date + INTERVAL '1 day')`;
  } else {
    query = `SELECT MAX(timestamp)::date::text AS date
             FROM upstox_daily_candlestick
             WHERE timestamp < $1::date`;
  }
  try {
    const { rows } = await queryPool.query(query, [date]);
    if (!rows[0]?.date) return res.status(404).json({ error: `No ${direction} candle date is available` });
    res.json({ market, direction, from: date, date: rows[0].date });
  } catch (err) {
    console.error('trading date lookup failed:', err);
    res.status(500).json({ error: 'Unable to find trading date' });
  }
});

// Calculate all four result sets once and cache them in Postgres.
app.post('/api/screener/generate/:date', async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const results = await calculateAndCacheDate(date, normaliseDataset(req.body?.dataset));
    res.json({ date, ...results, storage: 'postgres' });
  } catch (err) {
    console.error('screener generate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

registerPaperTradingRoutes(app, pool, DATE_RE);

// Per-user, cross-device "last picked date" (backs the LstDt floating
// button). Stored in postgres keyed by username so it follows the account,
// not the browser.
async function ensureUserPrefsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      username TEXT PRIMARY KEY,
      last_picked_date TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get('/api/user/last-date', async (req, res) => {
  try {
    await ensureUserPrefsTable();
    const { rows } = await pool.query(
      'SELECT last_picked_date FROM user_preferences WHERE username = $1 LIMIT 1',
      [req.auth.username]
    );
    res.json({ date: rows[0]?.last_picked_date || '' });
  } catch (err) {
    console.error('load last-date failed:', err);
    res.status(500).json({ error: 'Unable to load last picked date' });
  }
});

// LstDt in training jumps to the training date of the trade placed most
// recently in REAL time - not the latest training date, and not the last date
// picked on the calendar. If yesterday's session traded 10 Jun and today's
// traded 5 May, this returns 5 May: where you actually left off.
app.get('/api/user/last-trade-date', async (req, res) => {
  const username = String(req.auth?.username || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Username is invalid' });
  const dataset = normaliseDataset(req.query.dataset);
  try {
    const { rows } = await pool.query(
      `SELECT o.placed_date::text AS date
       FROM paper_trading_orders o
       JOIN paper_trading_sessions s ON s.id = o.session_id
       WHERE LOWER(s.username) = $1
         AND s.mode = 'training'
         AND s.dataset = $2
         AND o.placed_date IS NOT NULL
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [username, dataset]
    );
    res.json({ date: rows[0]?.date || '' });
  } catch (err) {
    console.error('load last-trade-date failed:', err);
    res.json({ date: '' });
  }
});

app.put('/api/user/last-date', async (req, res) => {
  const date = String(req.body?.date || '');
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });
  try {
    await ensureUserPrefsTable();
    await pool.query(
      `INSERT INTO user_preferences (username, last_picked_date)
       VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET last_picked_date = $2, updated_at = NOW()`,
      [req.auth.username, date]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('save last-date failed:', err);
    res.status(500).json({ error: 'Unable to save last picked date' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4010;

// Warm the Finviz/India caches from Postgres before accepting traffic, so the
// first request cannot see an empty screen list. A failure here is fatal on
// purpose: serving empty screens silently is worse than not starting.
pgFeeds.start(pool, GROUP_NAMES)
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`screener-backend listening on ${PORT} (0.0.0.0)`));
  })
  .catch((error) => {
    console.error('Unable to load screen data from PostgreSQL:', error.message);
    process.exit(1);
  });
