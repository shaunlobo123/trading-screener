// pgFeeds.js - the Finviz screens and the India universe, read from PostgreSQL.
//
// screener2 read these straight off disk:
//   /shared-data/csv/finviz_*.csv          -> finviz_screen_rows
//   /shared-data/csv/finviz_allfinviz.csv  -> finviz_universe
//   /shared-data/csv/mergec.csv            -> india_merged
//
// Those reads were synchronous and mtime-cached, and they sit inside
// synchronous helpers all over finvizData.js. Making them `await` would turn
// every one of those call sites async for no benefit, so the same shape is kept
// instead: a process-local cache with synchronous getters, refreshed in the
// background from Postgres. What used to be "has the file's mtime changed?" is
// now "has MAX(updated_at) for this list moved?", so a poll that finds nothing
// new costs one cheap aggregate rather than a re-parse.
//
// Rows come back under their original CSV header names ('Ticker', 'Price',
// 'Average True Range', ...) because that is what normaliseRow() expects.

const REFRESH_MS = Number(process.env.PG_FEED_REFRESH_MS || 30000);

const state = {
  pool: null,
  groups: new Map(),      // list_name -> { updatedAt, rows }
  universe: { updatedAt: null, rows: [] },
  merged: { updatedAt: null, rows: [] },
  ready: false,
};

async function loadGroup(listName) {
  const { rows: [stamp] } = await state.pool.query(
    'SELECT MAX(updated_at) AS updated_at, COUNT(*)::int AS n FROM finviz_screen_rows WHERE list_name = $1',
    [listName]
  );
  const updatedAt = stamp.updated_at ? stamp.updated_at.getTime() : null;
  const cached = state.groups.get(listName);
  // Row count is part of the check: a refresh that only deletes rows leaves
  // MAX(updated_at) untouched, and the cache would otherwise keep the dropped
  // tickers forever.
  if (cached && cached.updatedAt === updatedAt && cached.rows.length === stamp.n) return;

  const { rows } = await state.pool.query(
    'SELECT data FROM finviz_screen_rows WHERE list_name = $1',
    [listName]
  );
  state.groups.set(listName, { updatedAt, rows: rows.map((r) => r.data) });
}

async function loadUniverse() {
  const { rows: [stamp] } = await state.pool.query(
    'SELECT MAX(updated_at) AS updated_at, COUNT(*)::int AS n FROM finviz_universe'
  );
  const updatedAt = stamp.updated_at ? stamp.updated_at.getTime() : null;
  if (state.universe.updatedAt === updatedAt && state.universe.rows.length === stamp.n) return;
  const { rows } = await state.pool.query('SELECT data FROM finviz_universe');
  state.universe = { updatedAt, rows: rows.map((r) => r.data) };
}

async function loadMerged() {
  const { rows: [stamp] } = await state.pool.query(
    'SELECT MAX(updated_at) AS updated_at, COUNT(*)::int AS n FROM india_merged'
  );
  const updatedAt = stamp.updated_at ? stamp.updated_at.getTime() : null;
  if (state.merged.updatedAt === updatedAt && state.merged.rows.length === stamp.n) return;
  const { rows } = await state.pool.query('SELECT data FROM india_merged');
  state.merged = { updatedAt, rows: rows.map((r) => r.data) };
}

async function refresh(listNames) {
  await Promise.all([
    loadUniverse(),
    loadMerged(),
    ...listNames.map((name) => loadGroup(name)),
  ]);
  state.ready = true;
}

/**
 * Warm the cache once, then keep it fresh in the background.
 * Awaiting this at boot means the first request never sees an empty cache.
 */
async function start(pool, listNames) {
  state.pool = pool;
  await refresh(listNames);
  const timer = setInterval(() => {
    // A failed poll must not take the process down - the cache simply keeps
    // serving the last good copy until the next tick succeeds.
    refresh(listNames).catch((error) => {
      console.error('pgFeeds refresh failed:', error.message);
    });
  }, REFRESH_MS);
  timer.unref?.();
  return timer;
}

// ── Synchronous getters (drop-in for the old file reads) ─────────────────
const groupRows = (listName) => state.groups.get(listName)?.rows ?? [];
const hasGroup = (listName) => (state.groups.get(listName)?.rows.length ?? 0) > 0;
const universeRows = () => state.universe.rows;
const mergedRows = () => state.merged.rows;
const isReady = () => state.ready;

module.exports = {
  start, refresh, groupRows, hasGroup, universeRows, mergedRows, isReady,
};
