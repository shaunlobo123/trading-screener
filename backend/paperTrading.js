const { normaliseDataset, getPool, getSource } = require('./datasets');
const { latestPrice: latestFinvizPrice } = require('./finvizData');

const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;
const STARTING_CAPITAL = 100000;
const MODES = ['training', 'live'];

function registerPaperTradingRoutes(app, pool, DATE_RE) {
  let tablesReady;

  function ensureTables() {
    if (!tablesReady) {
      tablesReady = pool.query(`
        CREATE TABLE IF NOT EXISTS paper_trading_sessions (
          id BIGSERIAL PRIMARY KEY,
          username TEXT NOT NULL,
          start_date DATE NOT NULL,
          trading_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reset', 'released')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS paper_trading_orders (
          id BIGSERIAL PRIMARY KEY,
          session_id BIGINT NOT NULL REFERENCES paper_trading_sessions(id),
          market TEXT NOT NULL CHECK (market IN ('US', 'IN')),
          symbol TEXT NOT NULL,
          order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
          quantity NUMERIC NOT NULL CHECK (quantity > 0),
          initial_quantity NUMERIC NOT NULL CHECK (initial_quantity > 0),
          limit_price NUMERIC,
          stop_price NUMERIC CHECK (stop_price > 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
          placed_date DATE NOT NULL,
          entry_date DATE,
          entry_price NUMERIC,
          exit_date DATE,
          exit_price NUMERIC,
          exit_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE paper_trading_orders ADD COLUMN IF NOT EXISTS initial_quantity NUMERIC;
        ALTER TABLE paper_trading_orders ALTER COLUMN stop_price DROP NOT NULL;
        ALTER TABLE paper_trading_orders ADD COLUMN IF NOT EXISTS stop_hit_date DATE;
        ALTER TABLE paper_trading_orders ADD COLUMN IF NOT EXISTS journal_note TEXT;
        ALTER TABLE paper_trading_orders ADD COLUMN IF NOT EXISTS partial_close BOOLEAN NOT NULL DEFAULT FALSE;
        -- Releasing a closed trade from Holdings used to be a browser-local
        -- flag (localStorage), so a trade released on one device came back on
        -- every other one. It is a property of the trade, not of the browser.
        ALTER TABLE paper_trading_orders ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'paper_trading_exit_not_before_entry'
              AND conrelid = 'paper_trading_orders'::regclass
          ) THEN
            ALTER TABLE paper_trading_orders
              ADD CONSTRAINT paper_trading_exit_not_before_entry
              CHECK (exit_date IS NULL OR entry_date IS NULL OR exit_date >= entry_date)
              NOT VALID;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'paper_trading_entry_not_before_placed'
              AND conrelid = 'paper_trading_orders'::regclass
          ) THEN
            ALTER TABLE paper_trading_orders
              ADD CONSTRAINT paper_trading_entry_not_before_placed
              CHECK (status = 'cancelled' OR entry_date IS NULL OR entry_date >= placed_date)
              NOT VALID;
          END IF;
        END $$;
        UPDATE paper_trading_orders AS active_order
        SET initial_quantity = active_order.quantity + COALESCE((
          SELECT SUM(partial_order.quantity)
          FROM paper_trading_orders AS partial_order
          WHERE partial_order.session_id = active_order.session_id
            AND partial_order.id <> active_order.id
            AND partial_order.market = active_order.market
            AND partial_order.symbol = active_order.symbol
            AND partial_order.order_type = active_order.order_type
            AND partial_order.placed_date = active_order.placed_date
            AND partial_order.entry_date IS NOT DISTINCT FROM active_order.entry_date
            AND partial_order.entry_price IS NOT DISTINCT FROM active_order.entry_price
            AND partial_order.status = 'closed'
            AND partial_order.exit_reason IN ('take_profit', 'cut_loss')
            AND partial_order.created_at > active_order.created_at
        ), 0)
        WHERE active_order.initial_quantity IS NULL
          AND active_order.status = 'open';
        UPDATE paper_trading_orders SET initial_quantity = quantity WHERE initial_quantity IS NULL;
        ALTER TABLE paper_trading_orders ALTER COLUMN initial_quantity SET NOT NULL;

        -- Mark older partial-exit child rows so they do not get the journal
        -- note prompt. New partial exits are marked explicitly below.
        UPDATE paper_trading_orders AS partial_order
        SET partial_close = TRUE
        WHERE partial_order.status = 'closed'
          AND NOT partial_order.partial_close
          -- Do not rewrite legacy rows that predate the existing date
          -- constraint; those rows remain unchanged and are still viewable.
          AND (partial_order.entry_date IS NULL OR partial_order.entry_date >= partial_order.placed_date)
          AND EXISTS (
            SELECT 1 FROM paper_trading_orders AS remaining_order
            WHERE remaining_order.session_id = partial_order.session_id
              AND remaining_order.market = partial_order.market
              AND remaining_order.symbol = partial_order.symbol
              AND remaining_order.order_type = partial_order.order_type
              AND remaining_order.placed_date = partial_order.placed_date
              AND remaining_order.entry_date IS NOT DISTINCT FROM partial_order.entry_date
              AND remaining_order.entry_price IS NOT DISTINCT FROM partial_order.entry_price
              AND remaining_order.status IN ('open', 'closed')
              AND remaining_order.initial_quantity > remaining_order.quantity
              AND remaining_order.created_at < partial_order.created_at
          );

        CREATE INDEX IF NOT EXISTS paper_trading_orders_session_status
          ON paper_trading_orders (session_id, status);

        -- Two independent trading states per user: 'training' (historic
        -- screener backtest) and 'live' (finviz lists). Sessions, open
        -- orders, and account stats are tracked separately for each.
        ALTER TABLE paper_trading_sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'training';
        ALTER TABLE paper_trading_sessions ADD COLUMN IF NOT EXISTS dataset TEXT NOT NULL DEFAULT 'av';
        DROP INDEX IF EXISTS paper_trading_one_active_session_per_mode;
        CREATE UNIQUE INDEX IF NOT EXISTS paper_trading_one_active_session_per_mode_dataset
          ON paper_trading_sessions (username, mode, dataset) WHERE status = 'active';
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'paper_trading_sessions_mode_check'
              AND conrelid = 'paper_trading_sessions'::regclass
          ) THEN
            ALTER TABLE paper_trading_sessions
              ADD CONSTRAINT paper_trading_sessions_mode_check CHECK (mode IN ('training', 'live'));
          END IF;
        END $$;
        DROP INDEX IF EXISTS paper_trading_one_active_session;
        CREATE UNIQUE INDEX IF NOT EXISTS paper_trading_one_active_session_per_mode
          ON paper_trading_sessions (username, mode) WHERE status = 'active';

        -- 'released' marks a session the date lock was lifted from because
        -- every position closed, as distinct from 'reset' (the explicit
        -- ResetAllTrades click). Both drop out of the active lookup, but a
        -- released session's closed trades stay visible in Holdings so they
        -- can still be reviewed and journalled.
        ALTER TABLE paper_trading_sessions
          DROP CONSTRAINT IF EXISTS paper_trading_sessions_status_check;
        ALTER TABLE paper_trading_sessions
          ADD CONSTRAINT paper_trading_sessions_status_check
          CHECK (status IN ('active', 'reset', 'released'));
      `).catch((error) => {
        tablesReady = null;
        throw error;
      });
    }
    return tablesReady;
  }

  function usernameFrom(value) {
    const username = String(value || '').trim();
    return USERNAME_RE.test(username) ? username : null;
  }

  function normaliseMarket(value) {
    const market = String(value || '').toUpperCase();
    return ['US', 'IN'].includes(market) ? market : null;
  }

  function normaliseMode(value) {
    const mode = String(value || '').toLowerCase();
    return MODES.includes(mode) ? mode : null;
  }

  // Training follows the selected dataset. Norgate is US-only; the AV source
  // maps US to the existing daily candle table and India to Upstox.
  function datasetForMode(mode, value) {
    return normaliseDataset(value);
  }

  function normaliseSymbol(market, value) {
    const symbol = String(value || '').trim();
    if (!symbol || symbol.length > 100) return null;
    return market === 'US' ? symbol.toUpperCase() : symbol;
  }

  function numberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // Candle reads may target the separate norgate database; those run on its
  // own pool (read-only, outside the caller's master transaction).
  function candleRunner(client, dataset) {
    return normaliseDataset(dataset) === 'norgate' ? getPool('norgate') : client;
  }

  function candleSource(market, dataset = 'av') {
    const source = getSource(normaliseDataset(dataset), market);
    if (!source) throw new Error(`Dataset ${dataset} has no ${market} candles`);
    return {
      table: source.table,
      symbolColumn: source.symbolColumn,
      dateColumn: market === 'IN' ? 'timestamp::date' : source.dateColumn,
      dateColumnRaw: source.dateColumn,
      openColumn: source.open,
      highColumn: source.high,
      lowColumn: source.low,
      closeColumn: source.close,
      volumeColumn: source.volume,
    };
  }

  async function asOfCandle(client, market, symbol, date, dataset = 'av') {
    const source = candleSource(market, dataset);
    const runner = candleRunner(client, dataset);
    const { rows } = await runner.query(
      `SELECT ${source.dateColumnRaw}::text AS date,
              ${source.openColumn} AS open,
              ${source.highColumn} AS high,
              ${source.lowColumn} AS low,
              ${source.closeColumn} AS close
       FROM ${source.table}
       WHERE ${source.symbolColumn} = $1 AND ${source.dateColumn} <= $2::date
       ORDER BY ${source.dateColumnRaw} DESC
       LIMIT 1`,
      [symbol, date]
    );
    if (!rows.length) return null;
    return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [
      key,
      key === 'date' ? value : Number(value),
    ]));
  }

  async function firstStopCandle(client, order, fromDate, toDate, includeFrom = false, dataset = 'av') {
    if (order.stop_price == null) return null;
    const source = candleSource(order.market, dataset);
    const runner = candleRunner(client, dataset);
    const operator = includeFrom ? '>=' : '>';
    const { rows } = await runner.query(
      `SELECT ${source.dateColumnRaw}::text AS date,
              ${source.openColumn} AS open,
              ${source.lowColumn} AS low
       FROM ${source.table}
       WHERE ${source.symbolColumn} = $1
         AND ${source.dateColumn} ${operator} $2::date
         AND ${source.dateColumn} <= $3::date
         AND ${source.lowColumn} <= $4
       ORDER BY ${source.dateColumnRaw} ASC
       LIMIT 1`,
      [order.symbol, fromDate, toDate, order.stop_price]
    );
    return rows[0] || null;
  }

  async function firstLimitCandle(client, order, fromDate, toDate, dataset = 'av') {
    const source = candleSource(order.market, dataset);
    const runner = candleRunner(client, dataset);
    const { rows } = await runner.query(
      `SELECT ${source.dateColumnRaw}::text AS date,
              ${source.openColumn} AS open,
              ${source.lowColumn} AS low
       FROM ${source.table}
       WHERE ${source.symbolColumn} = $1
         AND ${source.dateColumn} > $2::date
         AND ${source.dateColumn} <= $3::date
         AND ${source.lowColumn} <= $4
       ORDER BY ${source.dateColumnRaw} ASC
       LIMIT 1`,
      [order.symbol, fromDate, toDate, order.limit_price]
    );
    return rows[0] || null;
  }

  async function closeAtStop(client, order, candle, mode) {
    if (order.entry_date && candle.date < order.entry_date) {
      throw new Error('A paper trade cannot close before its entry date');
    }
    // Live positions are never auto-closed: a stop hit is just recorded so
    // the UI can flag it and the user closes manually.
    if (mode === 'live') {
      await client.query(
        `UPDATE paper_trading_orders
         SET stop_hit_date = COALESCE(stop_hit_date, $2::date), updated_at = NOW()
         WHERE id = $1`,
        [order.id, candle.date]
      );
      return;
    }
    const stop = Number(order.stop_price);
    const open = Number(candle.open);
    const exitPrice = open < stop ? open : stop;
    await client.query(
      `UPDATE paper_trading_orders
       SET status = 'closed', exit_date = $2::date, exit_price = $3,
           exit_reason = 'stop_loss', updated_at = NOW()
       WHERE id = $1`,
      [order.id, candle.date, exitPrice]
    );
  }

  async function advanceSession(client, session, targetDate, mode = 'training', dataset = 'av') {
    if (targetDate === session.current_date) return;

    // Practice sessions may jump to any historical date. Moving backwards
    // changes only the current practice date; forward moves still process
    // pending entries and stops across the elapsed candles below.
    if (targetDate < session.current_date) {
      await client.query(
        `UPDATE paper_trading_sessions SET trading_date = $2::date, updated_at = NOW() WHERE id = $1`,
        [session.id, targetDate]
      );
      return;
    }

    const { rows: orders } = await client.query(
      `SELECT id, market, symbol, order_type, quantity, limit_price,
              stop_price, status, placed_date::text, entry_date::text, entry_price
       FROM paper_trading_orders
       WHERE session_id = $1 AND status IN ('pending', 'open')
       ORDER BY id`,
      [session.id]
    );

    for (const order of orders) {
      if (order.status === 'pending') {
        const fillFromDate = order.placed_date > session.current_date
          ? order.placed_date
          : session.current_date;
        const entryCandle = targetDate > fillFromDate
          ? await firstLimitCandle(client, order, fillFromDate, targetDate, dataset)
          : null;
        if (!entryCandle) continue;
        const limit = Number(order.limit_price);
        const entryPrice = Number(entryCandle.open) < limit ? Number(entryCandle.open) : limit;
        await client.query(
          `UPDATE paper_trading_orders
           SET status = 'open', entry_date = $2::date, entry_price = $3, updated_at = NOW()
           WHERE id = $1`,
          [order.id, entryCandle.date, entryPrice]
        );
        const filledOrder = { ...order, status: 'open', entry_date: entryCandle.date, entry_price: entryPrice };
        const stopCandle = await firstStopCandle(client, filledOrder, entryCandle.date, targetDate, true, dataset);
        if (stopCandle) await closeAtStop(client, filledOrder, stopCandle, mode);
      } else {
        const stopFromDate = order.entry_date && order.entry_date > session.current_date
          ? order.entry_date
          : session.current_date;
        const stopCandle = targetDate > stopFromDate
          ? await firstStopCandle(client, order, stopFromDate, targetDate, false, dataset)
          : null;
        if (stopCandle) await closeAtStop(client, order, stopCandle, mode);
      }
    }

    await client.query(
      `UPDATE paper_trading_sessions SET trading_date = $2::date, updated_at = NOW() WHERE id = $1`,
      [session.id, targetDate]
    );
  }

  function mapOrder(row) {
    const numeric = ['quantity', 'initial_quantity', 'limit_price', 'stop_price', 'entry_price', 'exit_price'];
    const order = { ...row };
    numeric.forEach((key) => {
      order[key] = numberOrNull(order[key]);
    });
    return order;
  }

  async function accountFor(username, mode = 'training', dataset = 'av') {
    const { rows } = await pool.query(
      `SELECT o.id, o.market, o.symbol, o.order_type, o.quantity, o.initial_quantity, o.limit_price,
              o.stop_price, o.status, o.placed_date::text, o.entry_date::text,
              o.entry_price, o.exit_date::text, o.exit_price, o.exit_reason, o.partial_close,
              s.id AS session_id, s.status AS session_status,
              s.start_date::text AS session_start_date,
              s.trading_date::text AS session_current_date,
              o.created_at, o.updated_at
       FROM paper_trading_orders o
       JOIN paper_trading_sessions s ON s.id = o.session_id
       WHERE s.username = $1 AND s.mode = $2 AND s.dataset = $3
         AND o.entry_price IS NOT NULL
         AND o.status IN ('open', 'closed')
       ORDER BY o.created_at DESC, o.id DESC`,
      [username, mode, dataset]
    );
    // Stats accumulate across every round (active, completed, or reset) —
    // trades from a session you've since finished with must still count,
    // otherwise win rate/running $ would reset every time a session ends.
    // An 'open' order only ever appears on the currently-active session, since
    // both /reset and the auto-release below force-close everything first.

    const trades = await Promise.all(rows.map(async (raw) => {
      const trade = mapOrder(raw);
      let valuationPrice = trade.exit_price;
      let valuationDate = trade.exit_date;
      if (trade.status === 'open') {
        if (trade.entry_date && trade.session_current_date < trade.entry_date) {
          valuationPrice = trade.entry_price;
          valuationDate = trade.session_current_date;
        } else {
          const candle = await asOfCandle(
            pool,
            trade.market,
            trade.symbol,
            trade.session_current_date
          );
          if (candle?.date && (!trade.entry_date || candle.date >= trade.entry_date)) {
            valuationPrice = candle.close;
            valuationDate = candle.date;
          } else {
            valuationPrice = trade.entry_price;
            valuationDate = trade.session_current_date;
          }
        }
      }
      const pnl = valuationPrice == null
        ? null
        : (valuationPrice - trade.entry_price) * trade.quantity;
      return {
        ...trade,
        current_date: valuationDate,
        current_price: valuationPrice,
        pnl,
        return_pct: trade.entry_price && valuationPrice != null
          ? ((valuationPrice - trade.entry_price) / trade.entry_price) * 100
          : null,
      };
    }));

    const closedTrades = trades.filter((trade) => trade.status === 'closed' && trade.pnl != null);
    const openTrades = trades.filter((trade) => trade.status === 'open' && trade.pnl != null);
    const realisedPnl = closedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const unrealisedPnl = openTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
    const losses = closedTrades.filter((trade) => trade.pnl < 0).length;

    return {
      starting_capital: STARTING_CAPITAL,
      realised_pnl: realisedPnl,
      unrealised_pnl: unrealisedPnl,
      running_amount: STARTING_CAPITAL + realisedPnl + unrealisedPnl,
      wins,
      losses,
      closed_trades: closedTrades.length,
      open_trades: openTrades.length,
      win_rate: closedTrades.length ? (wins / closedTrades.length) * 100 : 0,
      trades,
    };
  }

  async function stateFor(username, mode = 'training', dataset = 'av') {
    await ensureTables();
    const { rows: sessions } = await pool.query(
      `SELECT id, username, mode, dataset, start_date::text, trading_date::text AS current_date, status, created_at, updated_at
       FROM paper_trading_sessions
       WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'active'
       LIMIT 1`,
      [username, mode, dataset]
    );
    const session = sessions[0] || null;
    const activeDataset = normaliseDataset(session?.dataset || dataset);
    // Sessions auto-released once every position closed still own trades the
    // user has not reviewed yet, so their closed rows travel alongside the
    // active session's. Explicitly reset sessions stay excluded.
    const { rows: releasedSessions } = await pool.query(
      `SELECT id FROM paper_trading_sessions
       WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'released'`,
      [username, mode, activeDataset]
    );
    const sessionIds = [
      ...(session ? [session.id] : []),
      ...releasedSessions.map((row) => row.id),
    ];
    let orders = [];
    if (sessionIds.length) {
      const result = await pool.query(
        `SELECT id, market, symbol, order_type, quantity, initial_quantity, limit_price, stop_price, status,
                placed_date::text, entry_date::text, entry_price,
                exit_date::text, exit_price, exit_reason, stop_hit_date::text AS stop_hit_date,
                journal_note, partial_close, released_at,
                created_at, updated_at
         FROM paper_trading_orders
         WHERE session_id = ANY($1::bigint[])
           AND (session_id = $2 OR status = 'closed')
         ORDER BY id DESC`,
        [sessionIds, session ? session.id : 0]
      );
      orders = await Promise.all(result.rows.map(async (raw) => {
        const order = mapOrder(raw);
        // Only the active session can hold open positions, so anything else
        // needs no live valuation.
        if (order.status !== 'open' || !session) return order;
        // Live US holdings use Finviz's current snapshot/CSV feed. That path
        // is independent of IBeam and falls back to the last official daily
        // candle only if Finviz has no current price for the symbol.
        const finvizPrice = mode === 'live' && order.market === 'US'
          ? await latestFinvizPrice(pool, order.symbol)
          : null;
        const candle = finvizPrice == null
          ? await asOfCandle(pool, order.market, order.symbol, session.current_date, activeDataset)
          : null;
        const currentPrice = finvizPrice ?? candle?.close ?? order.entry_price;
        const partialClosedPct = Number(order.initial_quantity) > Number(order.quantity)
          ? ((Number(order.initial_quantity) - Number(order.quantity)) / Number(order.initial_quantity)) * 100
          : null;
        return {
          ...order,
          partial_closed_pct: partialClosedPct,
          current_price: currentPrice,
          unrealised_pnl: (currentPrice - order.entry_price) * order.quantity,
          unrealised_pct: order.entry_price ? ((currentPrice - order.entry_price) / order.entry_price) * 100 : null,
        };
      }));
    }
    return { username, mode, dataset: activeDataset, session, orders, account: await accountFor(username, mode, activeDataset) };
  }

  app.get('/api/paper/state', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const mode = normaliseMode(req.query.mode) || 'training';
    const dataset = datasetForMode(mode, req.query.dataset);
    if (!username) return res.status(400).json({ error: 'Username must use 1-40 letters, numbers, dot, dash, or underscore' });
    try {
      res.json(await stateFor(username, mode, dataset));
    } catch (error) {
      console.error('paper state failed:', error);
      res.status(500).json({ error: 'Unable to load paper-trading account' });
    }
  });

  app.get('/api/paper/leaderboard', async (req, res) => {
    try {
      await ensureTables();
      const { rows: users } = await pool.query(
        `SELECT LOWER(username) AS username FROM market_users ORDER BY LOWER(username)`
      );
      const stats = await Promise.all(users.map(async ({ username }) => {
        const account = await accountFor(username, 'training', 'norgate');
        return {
          username,
          starting_capital: account.starting_capital,
          running_amount: account.running_amount,
          total_pnl: account.realised_pnl + account.unrealised_pnl,
          realised_pnl: account.realised_pnl,
          unrealised_pnl: account.unrealised_pnl,
          win_rate: account.win_rate,
          wins: account.wins,
          losses: account.losses,
          closed_trades: account.closed_trades,
          open_trades: account.open_trades,
        };
      }));
      stats.sort((a, b) => b.running_amount - a.running_amount
        || b.win_rate - a.win_rate
        || a.username.localeCompare(b.username));
      res.json({
        leaderboard: stats.map((entry, index) => ({ rank: index + 1, ...entry })),
      });
    } catch (error) {
      console.error('leaderboard failed:', error);
      res.status(500).json({ error: 'Unable to load leaderboard' });
    }
  });

  app.post('/api/paper/orders', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const mode = normaliseMode(req.body.mode) || 'training';
    const dataset = datasetForMode(mode, req.body.dataset);
    if (dataset === 'norgate' && normaliseMarket(req.body.market) !== 'US') {
      return res.status(400).json({ error: 'Norgate covers US equities only' });
    }
    const market = normaliseMarket(req.body.market);
    const symbol = normaliseSymbol(market, req.body.symbol);
    const date = String(req.body.date || '');
    const orderType = String(req.body.orderType || '').toLowerCase();
    const requestedQuantity = numberOrNull(req.body.quantity);
    const quantity = requestedQuantity == null ? null : Math.floor(requestedQuantity);
    const limitPrice = numberOrNull(req.body.limitPrice);
    const stopPrice = numberOrNull(req.body.stopPrice);
    if (!username || !market || !symbol || !DATE_RE.test(date) || !['market', 'limit'].includes(orderType)) {
      return res.status(400).json({ error: 'Username, market, symbol, date, or order type is invalid' });
    }
    if (!(quantity > 0)) return res.status(400).json({ error: 'Quantity must be positive' });
    if (stopPrice != null && !(stopPrice > 0)) {
      return res.status(400).json({ error: 'Stop loss must be positive when supplied' });
    }
    if (orderType === 'limit' && !(limitPrice > 0)) {
      return res.status(400).json({ error: 'Limit price must be positive' });
    }

    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existing } = await client.query(
        `SELECT id, trading_date::text AS current_date FROM paper_trading_sessions
         WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'active' FOR UPDATE`,
        [username, mode, dataset]
      );
      let session = existing[0];
      if (!session) {
        const created = await client.query(
          `INSERT INTO paper_trading_sessions (username, mode, dataset, start_date, trading_date)
           VALUES ($1, $2, $3, $4::date, $4::date)
           RETURNING id, trading_date::text AS current_date`,
          [username, mode, dataset, date]
        );
        session = created.rows[0];
      } else if (session.current_date !== date) {
        await advanceSession(client, session, date, mode, dataset);
        session.current_date = date;
      }

      // Training enforces one position per symbol; live mirrors a real broker
      // where adding to the same stock is allowed.
      if (mode === 'training') {
        const { rows: duplicateOrders } = await client.query(
          `SELECT id FROM paper_trading_orders
           WHERE session_id = $1 AND market = $2 AND symbol = $3 AND status IN ('open', 'pending')
           LIMIT 1`,
          [session.id, market, symbol]
        );
        if (duplicateOrders.length) {
          throw new Error(`${symbol} already has an open or pending order - close it before placing another`);
        }
      }

      const candle = await asOfCandle(client, market, symbol, date, dataset);
      if (!candle) throw new Error(`No candle is available for ${symbol} on or before ${date}`);
      const referencePrice = orderType === 'market' ? candle.close : limitPrice;
      if (stopPrice != null && stopPrice >= referencePrice) {
        throw new Error('Stop price must be below the entry price');
      }

      // Live trades mirror a real broker workflow: an order is only ever an
      // intention until the user confirms the actual fill, so it stays
      // pending no matter where the limit sits relative to the close.
      const fillsNow = mode !== 'live' && (orderType === 'market' || limitPrice >= candle.close);
      const status = fillsNow ? 'open' : 'pending';
      const entryPrice = fillsNow ? candle.close : null;
      // The user trades from the selected Screener date. An immediately
      // filled order must therefore be recorded on that date even when the
      // symbol's latest available price candle is older (for example a thinly
      // traded symbol or a weekend practice date).
      const entryDate = fillsNow ? date : null;
      await client.query(
        `INSERT INTO paper_trading_orders
           (session_id, market, symbol, order_type, quantity, initial_quantity, limit_price, stop_price,
            status, placed_date, entry_date, entry_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12)`,
        [session.id, market, symbol, orderType, quantity, quantity,
          orderType === 'limit' ? limitPrice : null, stopPrice,
          status, date, entryDate, entryPrice]
      );
      await client.query('COMMIT');
      res.status(201).json(await stateFor(username, mode, dataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/paper/advance', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const mode = normaliseMode(req.body.mode) || 'training';
    const dataset = datasetForMode(mode, req.body.dataset);
    const date = String(req.body.date || '');
    if (!username || !DATE_RE.test(date)) return res.status(400).json({ error: 'Username or date is invalid' });
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, trading_date::text AS current_date FROM paper_trading_sessions
         WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'active' FOR UPDATE`,
        [username, mode, dataset]
      );
      if (!rows.length) throw new Error('No active paper-trading session');
      await advanceSession(client, rows[0], date, mode, dataset);
      await client.query('COMMIT');
      res.json(await stateFor(username, mode, dataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.patch('/api/paper/orders/:id/note', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    const note = String(req.body.note ?? '').slice(0, 4000);
    await ensureTables();
    try {
      const { rows } = await pool.query(
        `UPDATE paper_trading_orders o SET journal_note = $2, updated_at = NOW()
         FROM paper_trading_sessions s
         WHERE s.id = o.session_id AND o.id = $1 AND s.username = $3
           AND s.status IN ('active', 'released')
           AND NOT COALESCE(o.partial_close, FALSE)
         RETURNING o.id`,
        [req.params.id, note, username]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Trade not found' });
      res.json({ ok: true });
    } catch (error) {
      console.error('save journal note failed:', error);
      res.status(500).json({ error: 'Unable to save the journal note' });
    }
  });

  app.patch('/api/paper/orders/:id/release', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    // The note is optional: releasing without one is the common case.
    const note = req.body.note == null ? null : String(req.body.note).slice(0, 4000);
    await ensureTables();
    try {
      const { rows } = await pool.query(
        `UPDATE paper_trading_orders o
            SET released_at = NOW(),
                journal_note = COALESCE($2, o.journal_note),
                updated_at = NOW()
         FROM paper_trading_sessions s
         WHERE s.id = o.session_id AND o.id = $1 AND s.username = $3
           AND s.status IN ('active', 'released')
           AND o.status = 'closed'
           AND NOT COALESCE(o.partial_close, FALSE)
         RETURNING o.id, o.released_at`,
        [req.params.id, note, username]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Trade not found' });
      res.json({ ok: true, released_at: rows[0].released_at });
    } catch (error) {
      console.error('release trade failed:', error);
      res.status(500).json({ error: 'Unable to release the trade' });
    }
  });

  app.patch('/api/paper/orders/:id/stop', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const stopPrice = numberOrNull(req.body.stopPrice);
    if (!username || !(stopPrice > 0)) {
      return res.status(400).json({ error: 'Username or stop price is invalid' });
    }
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.market, o.symbol, o.status, o.limit_price,
                o.entry_date::text, o.entry_price, s.mode,
                s.dataset,
                s.trading_date::text AS current_date
         FROM paper_trading_orders o
         JOIN paper_trading_sessions s ON s.id = o.session_id
         WHERE o.id = $1 AND s.username = $2 AND s.status = 'active'
         FOR UPDATE OF o, s`,
        [req.params.id, username]
      );
      const order = rows[0];
      if (!order || !['open', 'pending'].includes(order.status)) {
        throw new Error('Active holding or order not found');
      }
      const orderDataset = normaliseDataset(order.dataset);

      if (order.status === 'pending') {
        if (stopPrice >= Number(order.limit_price)) {
          throw new Error('Stop price must be below the pending limit entry');
        }
        await client.query(
          `UPDATE paper_trading_orders SET stop_price = $2, updated_at = NOW() WHERE id = $1`,
          [order.id, stopPrice]
        );
      } else {
        if (order.entry_date && order.current_date < order.entry_date) {
          if (stopPrice >= Number(order.entry_price)) {
            throw new Error('Stop price must be below the entry price');
          }
          await client.query(
            `UPDATE paper_trading_orders SET stop_price = $2, updated_at = NOW() WHERE id = $1`,
            [order.id, stopPrice]
          );
        } else {
          const candle = await asOfCandle(client, order.market, order.symbol, order.current_date, orderDataset);
          if (!candle) throw new Error('No current candle is available');
          if (stopPrice >= candle.close) {
            if (order.mode === 'live') {
              // Live: a stop at/above the market is recorded as a hit, the
              // position stays open for a manual close.
              await client.query(
                `UPDATE paper_trading_orders
                 SET stop_price = $2, stop_hit_date = COALESCE(stop_hit_date, $3::date), updated_at = NOW()
                 WHERE id = $1`,
                [order.id, stopPrice, order.current_date]
              );
            } else {
              await client.query(
                `UPDATE paper_trading_orders
                 SET status = 'closed', stop_price = $2, exit_date = $3::date,
                     exit_price = $4, exit_reason = 'stop_loss_adjusted', updated_at = NOW()
                 WHERE id = $1`,
                [order.id, stopPrice, order.current_date, candle.close]
              );
            }
          } else {
            await client.query(
              `UPDATE paper_trading_orders SET stop_price = $2, updated_at = NOW() WHERE id = $1`,
              [order.id, stopPrice]
            );
          }
        }
      }

      await client.query('COMMIT');
      res.json(await stateFor(username, order.mode, orderDataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // Called (within the caller's own transaction) after a close/cancel that
  // might have emptied a session out. If nothing open or pending remains,
  // the session no longer needs to hold the date lock — mark it done so a
  // fresh random date can be picked without an explicit reset click.
  async function releaseSessionIfEmpty(client, sessionId) {
    const { rows } = await client.query(
      `SELECT 1 FROM paper_trading_orders
       WHERE session_id = $1 AND status IN ('open', 'pending') LIMIT 1`,
      [sessionId]
    );
    if (rows.length) return;
    // 'released', not 'reset': the date lock lifts, but the session's closed
    // trades stay in Holdings (struck through) until released one by one or
    // wiped by an explicit ResetAllTrades.
    await client.query(
      `UPDATE paper_trading_sessions SET status = 'released', updated_at = NOW()
       WHERE id = $1 AND status = 'active'`,
      [sessionId]
    );
  }

  // Confirm a pending (live) order actually filled at the broker. The entry
  // price defaults to the order's own limit price; an explicit fillPrice can
  // override it, and a stop loss may be attached in the same click.
  app.post('/api/paper/orders/:id/fill', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const requestedQuantity = numberOrNull(req.body.quantity); // optional partial fill
    const stopPrice = numberOrNull(req.body.stopPrice);
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.status, o.quantity, o.stop_price, o.limit_price,
                s.mode, s.dataset, s.trading_date::text AS current_date
         FROM paper_trading_orders o
         JOIN paper_trading_sessions s ON s.id = o.session_id
         WHERE o.id = $1 AND s.username = $2 AND s.status = 'active'
         FOR UPDATE OF o, s`,
        [req.params.id, username]
      );
      const order = rows[0];
      if (!order || order.status !== 'pending') {
        throw new Error('Pending order not found');
      }
      const orderDataset = normaliseDataset(order.dataset);
      const fillPrice = numberOrNull(req.body.fillPrice) ?? Number(order.limit_price);
      if (!(fillPrice > 0)) {
        throw new Error('Order has no limit price to fill at');
      }
      if (stopPrice != null && stopPrice >= fillPrice) {
        throw new Error('Stop loss must be below the fill price');
      }
      const quantity = requestedQuantity == null ? Number(order.quantity) : Math.floor(requestedQuantity);
      if (!(quantity > 0) || quantity > Number(order.quantity)) {
        throw new Error(`Quantity must be between 1 and ${order.quantity}`);
      }

      await client.query(
        `UPDATE paper_trading_orders
         SET status = 'open', entry_price = $2, entry_date = $3::date, quantity = $4,
             stop_price = COALESCE($5, stop_price), updated_at = NOW()
         WHERE id = $1`,
        [order.id, fillPrice, order.current_date, quantity, stopPrice]
      );
      await client.query('COMMIT');
      res.json(await stateFor(username, order.mode, orderDataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/paper/orders/:id/close', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const reason = String(req.body.reason || 'take_profit');
    const requestedQuantity = numberOrNull(req.body.quantity);
    if (!username || !['take_profit', 'cut_loss', 'manual_close'].includes(reason)) {
      return res.status(400).json({ error: 'Username or close reason is invalid' });
    }
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.session_id, o.market, o.symbol, o.order_type, o.quantity, o.initial_quantity,
                o.limit_price, o.stop_price, o.status, o.placed_date::text,
                o.entry_date::text, o.entry_price, s.mode,
                s.dataset,
                s.trading_date::text AS current_date
         FROM paper_trading_orders o
         JOIN paper_trading_sessions s ON s.id = o.session_id
         WHERE o.id = $1 AND s.username = $2 AND s.status = 'active'
         FOR UPDATE OF o, s`,
        [req.params.id, username]
      );
      const order = rows[0];
      if (!order || order.status !== 'open') throw new Error('Open holding not found');
      if (order.entry_date && order.current_date < order.entry_date) {
        throw new Error(`This trade cannot be closed before its ${order.entry_date} entry date`);
      }
      const orderQuantity = Number(order.quantity);
      const closeQuantity = requestedQuantity == null ? orderQuantity : requestedQuantity;
      if (!(closeQuantity > 0) || closeQuantity > orderQuantity) {
        throw new Error(`Exit quantity must be between 0 and ${orderQuantity}`);
      }
      const candle = await asOfCandle(client, order.market, order.symbol, order.current_date, normaliseDataset(order.dataset));
      if (!candle) throw new Error('No current candle is available');
      const exitDate = order.current_date;
      if (closeQuantity < orderQuantity) {
        await client.query(
          `UPDATE paper_trading_orders
           SET quantity = quantity - $2, updated_at = NOW()
           WHERE id = $1`,
          [order.id, closeQuantity]
        );
        await client.query(
          `INSERT INTO paper_trading_orders
             (session_id, market, symbol, order_type, quantity, initial_quantity, limit_price, stop_price,
              status, placed_date, entry_date, entry_price, exit_date, exit_price, exit_reason, partial_close)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   'closed', $9::date, $10::date, $11, $12::date, $13, $14, TRUE)`,
          [order.session_id, order.market, order.symbol, order.order_type, closeQuantity, closeQuantity,
            order.limit_price, order.stop_price, order.placed_date, order.entry_date,
            order.entry_price, exitDate, candle.close, reason]
        );
      } else {
        await client.query(
          `UPDATE paper_trading_orders
           SET status = 'closed', exit_date = $2::date, exit_price = $3,
               exit_reason = $4, updated_at = NOW()
           WHERE id = $1`,
          [order.id, exitDate, candle.close, reason]
        );
      }
      // Once every position from this session is closed out, there's nothing
      // left that a backdated trade could unfairly exploit — release the
      // date lock automatically so the next random date doesn't need an
      // explicit "reset" click first.
      await releaseSessionIfEmpty(client, order.session_id);
      await client.query('COMMIT');
      res.json(await stateFor(username, order.mode, normaliseDataset(order.dataset)));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // Manually set/adjust the entry price of a pending order (its limit) or
  // correct the entry price of an open holding.
  app.patch('/api/paper/orders/:id/entry', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const entryPrice = numberOrNull(req.body.entryPrice);
    if (!username || !(entryPrice > 0)) {
      return res.status(400).json({ error: 'Entry price must be positive' });
    }
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.status, o.stop_price,
                s.mode, s.dataset
         FROM paper_trading_orders o
         JOIN paper_trading_sessions s ON s.id = o.session_id
         WHERE o.id = $1 AND s.username = $2 AND s.status = 'active'
         FOR UPDATE OF o, s`,
        [req.params.id, username]
      );
      const order = rows[0];
      if (!order || !['pending', 'open'].includes(order.status)) {
        throw new Error('Pending order or open holding not found');
      }
      const orderDataset = normaliseDataset(order.dataset);
      if (order.stop_price != null && entryPrice <= Number(order.stop_price)) {
        throw new Error('Entry price must be above the current stop loss');
      }
      await client.query(
        `UPDATE paper_trading_orders
         SET limit_price = $2,
             entry_price = CASE WHEN status = 'open' THEN $2 ELSE entry_price END,
             updated_at = NOW()
         WHERE id = $1`,
        [order.id, entryPrice]
      );
      await client.query('COMMIT');
      res.json(await stateFor(username, order.mode, orderDataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  // Adjust the quantity of a pending order (before it fills).
  app.patch('/api/paper/orders/:id/quantity', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const requestedQuantity = numberOrNull(req.body.quantity);
    const quantity = requestedQuantity == null ? null : Math.floor(requestedQuantity);
    if (!username || !(quantity > 0)) {
      return res.status(400).json({ error: 'Quantity must be positive' });
    }
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT o.id, o.status, o.initial_quantity,
                s.mode, s.dataset
         FROM paper_trading_orders o
         JOIN paper_trading_sessions s ON s.id = o.session_id
         WHERE o.id = $1 AND s.username = $2 AND s.status = 'active'
         FOR UPDATE OF o, s`,
        [req.params.id, username]
      );
      const order = rows[0];
      if (!order || order.status !== 'pending') {
        throw new Error('Pending order not found');
      }
      const orderDataset = normaliseDataset(order.dataset);
      await client.query(
        `UPDATE paper_trading_orders SET quantity = $2, updated_at = NOW() WHERE id = $1`,
        [order.id, quantity]
      );
      await client.query('COMMIT');
      res.json(await stateFor(username, order.mode, orderDataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/paper/orders/:id', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    const client = await pool.connect();
    try {
      await ensureTables();
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE paper_trading_orders o
         SET status = 'cancelled', updated_at = NOW()
         FROM paper_trading_sessions s
         WHERE o.id = $1 AND o.session_id = s.id AND s.username = $2
           AND s.status = 'active' AND o.status = 'pending'
         RETURNING o.session_id, s.mode AS mode, s.dataset AS dataset`,
        [req.params.id, username]
      );
      if (!rows.length) throw new Error('Pending order not found');
      await releaseSessionIfEmpty(client, rows[0].session_id);
      await client.query('COMMIT');
      res.json(await stateFor(username, rows[0].mode, normaliseDataset(rows[0].dataset)));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(error.message === 'Pending order not found' ? 404 : 500)
        .json({ error: error.message === 'Pending order not found' ? error.message : 'Unable to cancel paper order' });
    } finally {
      client.release();
    }
  });

  app.post('/api/paper/reset', async (req, res) => {
    const username = usernameFrom(req.auth?.username);
    const mode = normaliseMode(req.body.mode) || 'training';
    const dataset = datasetForMode(mode, req.body.dataset);
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, trading_date::text AS current_date FROM paper_trading_sessions
         WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'active' FOR UPDATE`,
        [username, mode, dataset]
      );
      const session = rows[0];
      if (session) {
        const openOrders = await client.query(
          `SELECT id, market, symbol, entry_date::text, entry_price FROM paper_trading_orders
           WHERE session_id = $1 AND status = 'open' FOR UPDATE`,
          [session.id]
        );
        for (const order of openOrders.rows) {
          const beforeEntry = order.entry_date && session.current_date < order.entry_date;
          const candle = beforeEntry
            ? null
            : await asOfCandle(client, order.market, order.symbol, session.current_date, dataset);
          await client.query(
            `UPDATE paper_trading_orders SET status = 'closed', exit_date = $2::date,
               exit_price = $3, exit_reason = 'reset', updated_at = NOW() WHERE id = $1`,
            [order.id,
              beforeEntry ? order.entry_date : session.current_date,
              beforeEntry ? order.entry_price : (candle?.close || null)]
          );
        }
        await client.query(
          `UPDATE paper_trading_orders SET status = 'cancelled', updated_at = NOW()
           WHERE session_id = $1 AND status = 'pending'`,
          [session.id]
        );
        await client.query(
          `UPDATE paper_trading_sessions SET status = 'reset', updated_at = NOW() WHERE id = $1`,
          [session.id]
        );
      }
      // An explicit reset is the "clean slate" action, so it also clears the
      // closed trades still lingering from auto-released sessions.
      await client.query(
        `UPDATE paper_trading_sessions SET status = 'reset', updated_at = NOW()
         WHERE username = $1 AND mode = $2 AND dataset = $3 AND status = 'released'`,
        [username, mode, dataset]
      );
      await client.query('COMMIT');
      res.json(await stateFor(username, mode, dataset));
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Unable to reset paper-trading session' });
    } finally {
      client.release();
    }
  });
}

module.exports = { registerPaperTradingRoutes };
