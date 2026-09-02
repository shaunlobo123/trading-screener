// ═══════════════════════════════════════════════════════════════════════
// datasets.js — multi-dataset candle sources.
//
//   'av'      : master_database.candlestick_alphavantage (+ upstox for IN)
//   'norgate' : norgate_candlestick.norgate.us_trainable_daily
//               (US equities + delisted - survivorship-bias-free)
//
// Each dataset owns its own pg Pool since norgate lives in a separate
// database. Candle source configs describe how to read daily OHLCV so the
// screener/paper-trading code stays table-agnostic.
// ═══════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');

const DATASETS = ['av', 'norgate'];

function normaliseDataset(value) {
  return DATASETS.includes(value) ? value : 'av';
}

const pools = {
  av: new Pool({
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 10,
  }),
  norgate: new Pool({
    host: process.env.NORGATE_POSTGRES_HOST || process.env.POSTGRES_HOST,
    port: process.env.NORGATE_POSTGRES_PORT || process.env.POSTGRES_PORT,
    database: process.env.NORGATE_DB || 'norgate_candlestick',
    user: process.env.NORGATE_POSTGRES_USER || process.env.POSTGRES_USER,
    password: process.env.NORGATE_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
    max: 5,
  }),
  finvizIntraday: new Pool({
    host: process.env.FINVIZ_INTRADAY_POSTGRES_HOST || process.env.POSTGRES_HOST,
    port: process.env.FINVIZ_INTRADAY_POSTGRES_PORT || process.env.POSTGRES_PORT,
    database: process.env.FINVIZ_INTRADAY_DB || 'finviz_intraday_temp',
    user: process.env.FINVIZ_INTRADAY_POSTGRES_USER || process.env.POSTGRES_USER,
    password: process.env.FINVIZ_INTRADAY_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD,
    max: 3,
  }),
};

function getPool(dataset) {
  return pools[normaliseDataset(dataset)];
}

function getFinvizIntradayPool() {
  return pools.finvizIntraday;
}

let ready;
function ensureNorgateView() {
  if (!ready) {
    ready = pools.norgate.query(`
      CREATE OR REPLACE VIEW norgate.us_trainable_daily AS
      SELECT * FROM norgate.us_equities_daily
      UNION ALL
      SELECT * FROM norgate.us_equities_delisted_daily
    `).catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

// Daily-candle source description per dataset/market. `table` may be a
// subquery; every field interpolates into existing query templates.
const SOURCES = {
  av: {
    US: {
      table: 'candlestick_alphavantage',
      symbolColumn: 'symbol',
      dateColumn: 'date',
      open: 'open_price',
      high: 'high_price',
      low: 'low_price',
      close: 'close_price',
      volume: 'volume',
      universeQuery: 'SELECT DISTINCT symbol FROM candlestick_alphavantage ORDER BY symbol',
      universeField: 'symbol',
    },
    IN: {
      table: 'upstox_daily_candlestick',
      symbolColumn: 'link',
      dateColumn: 'timestamp',
      open: 'open',
      high: 'high',
      low: 'low',
      close: 'close',
      volume: 'volume',
      universeQuery: 'SELECT DISTINCT link FROM upstox_daily_candlestick ORDER BY link',
      universeField: 'link',
    },
  },
  norgate: {
    US: {
      table: 'norgate.us_trainable_daily',
      symbolColumn: 'symbol',
      dateColumn: 'trade_date',
      open: 'open_price',
      high: 'high_price',
      low: 'low_price',
      close: 'close_price',
      volume: 'volume',
      universeQuery: "SELECT DISTINCT symbol FROM norgate.us_trainable_daily WHERE symbol !~ '[^A-Za-z0-9]' ORDER BY symbol",
      universeField: 'symbol',
    },
  },
};

function getSource(dataset, market) {
  return SOURCES[normaliseDataset(dataset)]?.[market] || null;
}

module.exports = {
  DATASETS,
  normaliseDataset,
  getPool,
  getFinvizIntradayPool,
  getSource,
  ensureNorgateView,
};
