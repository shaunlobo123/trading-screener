const fs = require('fs');
const path = require('path');
const pgFeeds = require('./pgFeeds');

const INTRADAY_JSON_PATH = process.env.FINVIZ_INTRADAY_JSON_PATH
  || '/shared-data/csv/finviz_intraday_candle_today.json';

const GROUPS = {
  MomentumMerged: { sources: ['perf_1mth', 'perf_3mth', 'perf_6mth'] },
  '1mth30pc': { sources: ['perf_1mth'] },
  '3mths50pc': { sources: ['perf_3mth'] },
  '6mths30pc': { sources: ['perf_6mth'] },
  VolChange: { sources: ['vol_change'] },
  EarningsPrev5days: { sources: ['earnings'] },
  EarningsNxt5days: { sources: ['earnings'] },
  Breakout: { sources: [] },
  Kane: { sources: [] },
  highUp: { sources: [] },
  DeepLow: { sources: [] },
};
const WATCHLIST_GROUP = 'Watchlist';

function newYorkDate(now = new Date()) {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((parts, part) => {
    if (part.type !== 'literal') parts[part.type] = part.value;
    return parts;
  }, {});
  return `${values.year}-${values.month}-${values.day}`;
}

function isUsWeekday(dateString) {
  const day = new Date(`${dateString}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function effectiveTradingToday() {
  const now = new Date();
  const today = newYorkDate(now);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (!day) now.setUTCDate(now.getUTCDate() - 2);
  if (day === 6) now.setUTCDate(now.getUTCDate() - 1);
  return newYorkDate(now);
}

let watchlistTableReady;
function ensureWatchlistTable(pool) {
  if (!watchlistTableReady) {
    watchlistTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS screener2_watchlist (
        username TEXT NOT NULL,
        symbol TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (username, symbol)
      );
      CREATE INDEX IF NOT EXISTS screener2_watchlist_user_added
        ON screener2_watchlist (username, added_at DESC);
    `).catch((error) => {
      watchlistTableReady = null;
      throw error;
    });
  }
  return watchlistTableReady;
}

let viewedTableReady;
function ensureViewedTable(pool) {
  if (!viewedTableReady) {
    viewedTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS screener2_viewed_symbols (
        username TEXT NOT NULL,
        trade_date DATE NOT NULL,
        symbol TEXT NOT NULL,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (username, trade_date, symbol)
      );
      CREATE INDEX IF NOT EXISTS screener2_viewed_symbols_date_symbol_idx
        ON screener2_viewed_symbols (trade_date, symbol);
    `).catch((error) => {
      viewedTableReady = null;
      throw error;
    });
  }
  return viewedTableReady;
}

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const number = Number.parseFloat(String(value).replace(/[%,$"]/g, '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
};

const booleanValue = (value) => ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());

function currentEarningsSoonSymbols() {
  return new Set(
    pgFeeds.groupRows('EarningsNxt5days')
      .map((row) => String(row.Ticker || '').trim().toUpperCase())
      .filter(Boolean)
  );
}

function normaliseRow(raw, source = '') {
  const close = numberOrNull(raw.Price);
  const volume = numberOrNull(raw.Volume);
  const dollarVolume = close != null && volume != null ? close * volume : null;
  return {
    symbol: String(raw.Ticker || '').trim().toUpperCase(),
    company: raw.Company || '',
    close,
    pct_up: numberOrNull(raw.Change),
    dollar_up: close != null && numberOrNull(raw.Change) != null
      ? close * numberOrNull(raw.Change) / (100 + numberOrNull(raw.Change))
      : null,
    pct_from_low_1mth: numberOrNull(raw.PctFromLow),
    adr: numberOrNull(raw.ADR),
    atr: numberOrNull(raw['Average True Range']),
    sl: numberOrNull(raw.SL),
    relative_volume: numberOrNull(raw['Relative Volume']),
    volume,
    market_cap: dollarVolume == null ? null : Math.round(dollarVolume),
    dollar_volume: dollarVolume == null ? null : Math.round(dollarVolume),
    actual_market_cap: numberOrNull(raw['Market Cap']),
    source,
    momentum_window: raw.MomentumWindow || '',
    earnings_date: raw['Earnings Date'] || '',
    earnings_soon: booleanValue(raw.EarningsSoon),
  };
}

function sortBySlAscending(rows) {
  return rows.sort((a, b) => {
    const aSl = Number(a.sl);
    const bSl = Number(b.sl);
    const aMissing = a.sl == null || !Number.isFinite(aSl);
    const bMissing = b.sl == null || !Number.isFinite(bSl);
    if (aMissing && bMissing) return a.symbol.localeCompare(b.symbol);
    if (aMissing) return 1;
    if (bMissing) return -1;
    return aSl - bSl || a.symbol.localeCompare(b.symbol);
  });
}

function readCurrentGroup(group) {
  if (!GROUPS[group]) return null;
  // pgFeeds already caches and only re-reads when the list actually changed,
  // so there is no second layer of caching to keep here.
  const rawRows = pgFeeds.groupRows(group);
  const liveUniverse = currentUniverseRows();
  const earningsSoon = currentEarningsSoonSymbols();
  const rows = sortBySlAscending(rawRows.map((raw) => {
    const normalised = normaliseRow(raw, 'live');
    const row = { ...normalised, earnings_soon: normalised.earnings_soon || earningsSoon.has(normalised.symbol) };
    const live = liveUniverse.get(row.symbol);
    if (!live) return row;
    const close = live.close ?? row.close;
    const volume = live.volume ?? row.volume;
    const dollarUp = live.dollar_up ?? row.dollar_up;
    const atr = live.atr ?? row.atr;
    return {
      ...row,
      close,
      pct_up: live.pct_up ?? row.pct_up,
      dollar_up: dollarUp,
      volume,
      relative_volume: live.relative_volume ?? row.relative_volume,
      atr,
      sl: atr != null && dollarUp != null
        ? Math.round((atr - Math.abs(dollarUp)) * 100) / 100
        : row.sl,
      market_cap: close != null && volume != null ? Math.round(close * volume) : row.market_cap,
      actual_market_cap: row.actual_market_cap ?? live.actual_market_cap,
    };
  }).filter((row) => row.symbol));
  return rows;
}

function currentUniverseRows() {
  const earningsSoon = currentEarningsSoonSymbols();
  return new Map(pgFeeds.universeRows().map((row) => {
    const normalised = normaliseRow(row, 'live-universe');
    return [normalised.symbol, {
      ...normalised,
      earnings_soon: normalised.earnings_soon || earningsSoon.has(normalised.symbol),
    }];
  }).filter(([symbol]) => symbol));
}

async function userWatchlist(pool, username) {
  await ensureWatchlistTable(pool);
  const { rows } = await pool.query(
    `SELECT symbol, added_at FROM screener2_watchlist
     WHERE username = $1 ORDER BY added_at DESC, symbol`,
    [username]
  );
  const universe = currentUniverseRows();
  return {
    symbols: rows.map((row) => row.symbol),
    rows: rows.map((row) => {
      const live = universe.get(row.symbol);
      return live ? { ...live, watchlist_added_at: row.added_at } : null;
    }).filter(Boolean),
  };
}

function intradayCandle(symbol) {
  try {
    const payload = JSON.parse(fs.readFileSync(INTRADAY_JSON_PATH, 'utf8'));
    const today = newYorkDate();
    // A Finviz snapshot is valid only for the current New York weekday. This
    // rejects Friday's file over a weekend/holiday instead of appending it to
    // an already-complete daily candle.
    if (payload.date !== today || !isUsWeekday(today)) return null;
    const candle = payload.candles?.[symbol.toUpperCase()];
    const close = numberOrNull(candle?.close_price);
    if (close == null) return null;
    return {
      time: today,
      open: numberOrNull(candle.open_price) ?? close,
      high: numberOrNull(candle.high_price) ?? close,
      low: numberOrNull(candle.low_price) ?? close,
      close,
      // This is an in-progress price candle, not an official daily volume
      // figure. Keep it out of the chart's volume series entirely.
      volume: 0,
      temporary: true,
      source: 'intraday-json',
    };
  } catch {
    return null;
  }
}

function mergeIntradayCandle(candles, symbol, selectedDate) {
  const liveCandle = intradayCandle(symbol);
  if (!liveCandle || liveCandle.time !== selectedDate) return candles;
  // The base database wins once it has the official daily bar. This is what
  // prevents a second candle on weekends, holidays, or after the nightly load.
  if (candles.some((candle) => candle.time === liveCandle.time)) return candles;
  return [...candles, liveCandle];
}

function latestLiveCandle(symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  const intraday = intradayCandle(cleanSymbol);
  if (intraday) return intraday;

  const live = currentUniverseRows().get(cleanSymbol);
  if (live?.close == null) return null;
  const denominator = 1 + (live.pct_up ?? 0) / 100;
  const previousClose = denominator > 0 ? live.close / denominator : live.close;
  return {
    time: new Date().toISOString().slice(0, 10),
    open: previousClose,
    high: Math.max(previousClose, live.close),
    low: Math.min(previousClose, live.close),
    close: live.close,
    volume: live.volume ?? 0,
    source: 'live-universe',
  };
}

function priceFromCachedGroups(symbol) {
  // Last resort before hitting candlestick_alphavantage: scan the group lists
  // for any row carrying a price. These are the same rows readCurrentGroup
  // serves, but taken raw from the cache - the Finviz header names, not the
  // normalised ones, because normaliseRow is not run on this path.
  for (const group of Object.keys(GROUPS)) {
    for (const raw of pgFeeds.groupRows(group)) {
      if (String(raw.Ticker || '').trim().toUpperCase() !== symbol) continue;
      const close = numberOrNull(raw.Price);
      if (close != null) return close;
    }
  }
  return null;
}

async function latestPrice(pool, symbol) {
  const cleanSymbol = String(symbol || '').trim().toUpperCase();
  const intraday = intradayCandle(cleanSymbol)?.close;
  if (intraday != null) return intraday;
  const csvPrice = currentUniverseRows().get(cleanSymbol)?.close;
  if (csvPrice != null) return csvPrice;
  const cachedPrice = priceFromCachedGroups(cleanSymbol);
  if (cachedPrice != null) return cachedPrice;
  const { rows } = await pool.query(
    `SELECT close_price FROM candlestick_alphavantage
     WHERE symbol = $1 ORDER BY date DESC LIMIT 1`,
    [cleanSymbol]
  );
  return rows[0] ? Number(rows[0].close_price) : null;
}

function registerFinvizDataRoutes(app, pool, dateRe) {
  app.get('/api/finviz/groups', (req, res) => {
    const groups = Object.entries(GROUPS)
      .filter(([name]) => pgFeeds.hasGroup(name))
      .map(([name, config]) => ({ name, historical: config.sources.length > 0 }));
    groups.push({ name: WATCHLIST_GROUP, historical: false });
    res.json(groups);
  });

  app.get('/api/finviz/watchlist', async (req, res) => {
    try {
      res.json(await userWatchlist(pool, req.auth.username));
    } catch (error) {
      res.status(500).json({ error: 'Unable to load watchlist' });
    }
  });

  app.post('/api/finviz/watchlist', async (req, res) => {
    const symbol = String(req.body.symbol || req.body.ticker || '').trim().toUpperCase();
    const action = String(req.body.action || 'add').toLowerCase();
    if (!/^[A-Z0-9.-]{1,20}$/.test(symbol) || !['add', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Ticker or watchlist action is invalid' });
    }
    try {
      await ensureWatchlistTable(pool);
      if (action === 'remove') {
        await pool.query(
          'DELETE FROM screener2_watchlist WHERE username = $1 AND symbol = $2',
          [req.auth.username, symbol]
        );
      } else {
        await pool.query(
          `INSERT INTO screener2_watchlist (username, symbol)
           VALUES ($1, $2) ON CONFLICT (username, symbol) DO NOTHING`,
          [req.auth.username, symbol]
        );
      }
      res.json(await userWatchlist(pool, req.auth.username));
    } catch (error) {
      res.status(500).json({ error: 'Unable to update watchlist' });
    }
  });

  app.get('/api/finviz/viewed', async (req, res) => {
    const tradeDate = String(req.query.date || '');
    if (!dateRe.test(tradeDate)) return res.status(400).json({ error: 'Invalid date' });
    try {
      await ensureViewedTable(pool);
      const { rows } = await pool.query(
        `SELECT symbol FROM screener2_viewed_symbols
         WHERE username = $1 AND trade_date = $2::date ORDER BY symbol`,
        [req.auth.username, tradeDate]
      );
      res.json({ date: tradeDate, symbols: rows.map((row) => row.symbol) });
    } catch (error) {
      res.status(500).json({ error: 'Unable to load viewed tickers' });
    }
  });

  app.put('/api/finviz/viewed/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    const tradeDate = String(req.body.date || '');
    const viewed = req.body.viewed === true;
    if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol) || !dateRe.test(tradeDate)) {
      return res.status(400).json({ error: 'Ticker or date is invalid' });
    }
    try {
      await ensureViewedTable(pool);
      if (viewed) {
        await pool.query(
          `INSERT INTO screener2_viewed_symbols (username, trade_date, symbol)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (username, trade_date, symbol) DO UPDATE SET viewed_at = NOW()`,
          [req.auth.username, tradeDate, symbol]
        );
      } else {
        await pool.query(
          `DELETE FROM screener2_viewed_symbols
           WHERE username = $1 AND trade_date = $2::date AND symbol = $3`,
          [req.auth.username, tradeDate, symbol]
        );
      }
      await pool.query(
        `DELETE FROM screener2_viewed_symbols WHERE trade_date < CURRENT_DATE - INTERVAL '7 days'`
      );
      res.json({ date: tradeDate, symbol, viewed });
    } catch (error) {
      res.status(500).json({ error: 'Unable to update viewed ticker' });
    }
  });

  app.get('/api/finviz/price/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol)) {
      return res.status(400).json({ error: 'Invalid ticker' });
    }
    try {
      const price = await latestPrice(pool, symbol);
      if (!(price > 0)) return res.status(404).json({ error: 'Current price unavailable' });
      res.json({
        symbol,
        price,
        earningsSoon: currentEarningsSoonSymbols().has(symbol),
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: 'Unable to load current price' });
    }
  });

  app.get('/api/finviz/dates', async (req, res) => {
    const group = String(req.query.group || 'MomentumMerged');
    if (group === WATCHLIST_GROUP) {
      return res.json([effectiveTradingToday()]);
    }
    const config = GROUPS[group];
    if (!config) return res.status(400).json({ error: 'Unknown Finviz list' });
    try {
      const today = effectiveTradingToday();
      if (!config.sources.length) return res.json([today]);
      const { rows } = await pool.query(
        `SELECT DISTINCT snapshot_date::text AS date
         FROM finviz_daily_full
         WHERE source = ANY($1::text[])
         ORDER BY date DESC`,
        [config.sources]
      );
      const dates = rows.map((row) => row.date);
      if (!dates.includes(today)) dates.unshift(today);
      res.json(dates);
    } catch (error) {
      console.error('finviz dates failed:', error);
      res.status(500).json({ error: 'Unable to load Finviz dates' });
    }
  });

  app.get('/api/finviz/results/:group/:date', async (req, res) => {
    const group = String(req.params.group);
    const date = String(req.params.date);
    if (group === WATCHLIST_GROUP && dateRe.test(date)) {
      try {
        const watchlist = await userWatchlist(pool, req.auth.username);
        sortBySlAscending(watchlist.rows);
        return res.json({ group, date, count: watchlist.rows.length, source: 'user-watchlist', rows: watchlist.rows });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to load watchlist' });
      }
    }
    const config = GROUPS[group];
    if (!config || !dateRe.test(date)) return res.status(400).json({ error: 'Invalid list or date' });
    try {
      const today = effectiveTradingToday();
      if (date === today) {
        const rows = readCurrentGroup(group) || [];
        return res.json({ group, date, count: rows.length, source: 'live-csv', rows });
      }
      if (!config.sources.length) {
        return res.json({ group, date, count: 0, source: 'no-history', rows: [] });
      }
      const result = await pool.query(
        `SELECT ticker, source, data
         FROM finviz_daily_full
         WHERE snapshot_date = $1::date AND source = ANY($2::text[])
         ORDER BY ticker, array_position($2::text[], source)`,
        [date, config.sources]
      );
      const seen = new Set();
      const rows = [];
      for (const row of result.rows) {
        const normalised = normaliseRow(row.data, row.source);
        if (!normalised.symbol || seen.has(normalised.symbol)) continue;
        seen.add(normalised.symbol);
        rows.push(normalised);
      }
      sortBySlAscending(rows);
      res.json({ group, date, count: rows.length, source: 'postgres', rows });
    } catch (error) {
      console.error('finviz results failed:', error);
      res.status(500).json({ error: 'Unable to load Finviz results' });
    }
  });

  app.get('/api/finviz/trading-date/:direction/:date', async (req, res) => {
    const direction = String(req.params.direction);
    const date = String(req.params.date);
    const group = String(req.query.group || 'MomentumMerged');
    const config = group === WATCHLIST_GROUP ? { sources: [] } : GROUPS[group];
    if (!config || !['next', 'previous'].includes(direction) || !dateRe.test(date)) {
      return res.status(400).json({ error: 'Invalid list, direction, or date' });
    }
    try {
      const datesResponse = config.sources.length
        ? await pool.query(
          `SELECT DISTINCT snapshot_date::text AS date FROM finviz_daily_full
           WHERE source = ANY($1::text[]) ORDER BY date ASC`,
          [config.sources]
        )
        : { rows: [] };
      const today = effectiveTradingToday();
      const dates = [...new Set([...datesResponse.rows.map((row) => row.date), today])].sort();
      const candidates = direction === 'next'
        ? dates.filter((candidate) => candidate > date)
        : dates.filter((candidate) => candidate < date).reverse();
      if (!candidates.length) return res.status(404).json({ error: `No ${direction} date is available` });
      res.json({ date: candidates[0] });
    } catch (error) {
      res.status(500).json({ error: 'Unable to find another Finviz date' });
    }
  });
}

module.exports = {
  GROUP_NAMES: Object.keys(GROUPS),
  registerFinvizDataRoutes,
  intradayCandle,
  mergeIntradayCandle,
  latestLiveCandle,
  latestPrice,
};
