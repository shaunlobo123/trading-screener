const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const USERNAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const PASSWORD_RE = /[^A-Za-z0-9]/;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 60;
const TOKEN_LIFETIME = '1h';
const ADMIN_USERNAME = String(process.env.SCREENER_ADMIN_USERNAME || 'edward').toLowerCase();

let tablesReady;
let jwtSecretPromise;

function normaliseUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : null;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && PASSWORD_RE.test(password);
}

function ensureTables(pool) {
  if (!tablesReady) {
    tablesReady = pool.query(`
      CREATE TABLE IF NOT EXISTS market_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(40) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS risk_per_trade NUMERIC NOT NULL DEFAULT 200;
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS training_risk_per_trade NUMERIC NOT NULL DEFAULT 200;
      -- Chart preferences. Reviewing a closed trade and trading it are two
      -- different jobs: ChartDirector shows the fills and the whole run-up,
      -- the TradingView-style chart is the one to trade on. Defaults keep the
      -- behaviour users already had, with the review auto-switch on.
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS review_chart_cd BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE market_users ADD COLUMN IF NOT EXISTS trading_chart_tv BOOLEAN NOT NULL DEFAULT TRUE;
      CREATE UNIQUE INDEX IF NOT EXISTS market_users_username_lower_unique ON market_users (LOWER(username));
      CREATE TABLE IF NOT EXISTS screener_auth_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  return tablesReady;
}

async function jwtSecret(pool) {
  if (!jwtSecretPromise) {
    jwtSecretPromise = (async () => {
      await ensureTables(pool);
      const generated = crypto.randomBytes(48).toString('hex');
      await pool.query(
        `INSERT INTO screener_auth_config (key, value)
         VALUES ('jwt_secret', $1)
         ON CONFLICT (key) DO NOTHING`,
        [generated]
      );
      const { rows } = await pool.query(
        `SELECT value FROM screener_auth_config WHERE key = 'jwt_secret'`
      );
      if (!rows[0]?.value) throw new Error('Unable to initialise authentication secret');
      return rows[0].value;
    })().catch((error) => {
      jwtSecretPromise = null;
      throw error;
    });
  }
  return jwtSecretPromise;
}

function publicUser(username, riskPerTrade = 200, trainingRiskPerTrade = 200,
                   reviewChartCd = true, tradingChartTv = true) {
  return {
    username,
    isAdmin: username.toLowerCase() === ADMIN_USERNAME,
    riskPerTrade: Number(riskPerTrade) || 200,
    trainingRiskPerTrade: Number(trainingRiskPerTrade) || Number(riskPerTrade) || 200,
    reviewChartCd: reviewChartCd !== false,
    tradingChartTv: tradingChartTv !== false,
  };
}

function registerPublicAuthRoutes(app, pool) {
  app.post('/api/auth/login', async (req, res) => {
    const username = normaliseUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    try {
      await ensureTables(pool);
      const { rows } = await pool.query(
        `SELECT id, username, password, failed_attempts, locked_until, risk_per_trade, training_risk_per_trade,
                review_chart_cd, trading_chart_tv
         FROM market_users WHERE LOWER(username) = $1 LIMIT 1`,
        [username]
      );
      const user = rows[0];
      const locked = user?.locked_until && new Date(user.locked_until) > new Date();
      if (locked) {
        return res.status(423).json({ error: 'Account is locked. Please try again later.' });
      }

      const matches = user ? await bcrypt.compare(password, user.password) : false;
      if (!matches) {
        if (user) {
          const failedAttempts = Number(user.failed_attempts || 0) + 1;
          const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
            : null;
          await pool.query(
            `UPDATE market_users
             SET failed_attempts = $1, locked_until = $2, updated_at = NOW()
             WHERE id = $3`,
            [failedAttempts, lockedUntil, user.id]
          );
        }
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      await pool.query(
        `UPDATE market_users SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      const token = jwt.sign(
        { sub: String(user.id), username: user.username.toLowerCase() },
        await jwtSecret(pool),
        { expiresIn: TOKEN_LIFETIME }
      );
      res.json({ token, user: publicUser(user.username.toLowerCase(), user.risk_per_trade,
        user.training_risk_per_trade, user.review_chart_cd, user.trading_chart_tv) });
    } catch (error) {
      console.error('login failed:', error);
      res.status(500).json({ error: 'Unable to log in' });
    }
  });
}

function authenticate(pool) {
  return async (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Login required' });
    try {
      const payload = jwt.verify(token, await jwtSecret(pool));
      const username = normaliseUsername(payload.username);
      if (!username) throw new Error('Invalid token user');
      const { rows } = await pool.query(
        `SELECT risk_per_trade, training_risk_per_trade, review_chart_cd, trading_chart_tv
         FROM market_users WHERE id = $1 AND LOWER(username) = $2 LIMIT 1`,
        [Number(payload.sub), username]
      );
      if (!rows[0]) throw new Error('User no longer exists');
      req.auth = {
        userId: Number(payload.sub), username, isAdmin: username === ADMIN_USERNAME,
        riskPerTrade: Number(rows[0].risk_per_trade) || 200,
        trainingRiskPerTrade: Number(rows[0].training_risk_per_trade) || Number(rows[0].risk_per_trade) || 200,
        reviewChartCd: rows[0].review_chart_cd !== false,
        tradingChartTv: rows[0].trading_chart_tv !== false,
      };
      next();
    } catch (error) {
      res.status(401).json({ error: 'Login expired. Please log in again.' });
    }
  };
}

function requireAdmin(req, res, next) {
  if (!req.auth?.isAdmin) return res.status(403).json({ error: 'Edward administrator access is required' });
  next();
}

function registerProtectedAuthRoutes(app, pool) {
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: publicUser(req.auth.username, req.auth.riskPerTrade, req.auth.trainingRiskPerTrade,
      req.auth.reviewChartCd, req.auth.tradingChartTv) });
  });

  app.patch('/api/profile', async (req, res) => {
    const riskPerTrade = Number(req.body.riskPerTrade);
    if (!Number.isFinite(riskPerTrade) || !(riskPerTrade > 0) || riskPerTrade > 1000000000) {
      return res.status(400).json({ error: 'Risk per trade must be a positive amount' });
    }
    // Training risk is optional; when omitted it keeps its current value.
    const hasTrainingRisk = req.body.trainingRiskPerTrade !== undefined && req.body.trainingRiskPerTrade !== '';
    const trainingRiskPerTrade = Number(req.body.trainingRiskPerTrade);
    if (hasTrainingRisk && (!Number.isFinite(trainingRiskPerTrade) || !(trainingRiskPerTrade > 0) || trainingRiskPerTrade > 1000000000)) {
      return res.status(400).json({ error: 'Training risk per trade must be a positive amount' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE market_users SET
           risk_per_trade = $1,
           training_risk_per_trade = CASE WHEN $4::boolean THEN $3 ELSE training_risk_per_trade END,
           updated_at = NOW()
         WHERE id = $2 AND LOWER(username) = $5
         RETURNING LOWER(username) AS username, risk_per_trade, training_risk_per_trade`,
        [riskPerTrade, req.auth.userId, trainingRiskPerTrade, hasTrainingRisk, req.auth.username]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json({ user: publicUser(rows[0].username, rows[0].risk_per_trade, rows[0].training_risk_per_trade) });
    } catch (error) {
      res.status(500).json({ error: 'Unable to update profile' });
    }
  });

  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      await ensureTables(pool);
      const { rows } = await pool.query(
        `SELECT LOWER(username) AS username, risk_per_trade, review_chart_cd, trading_chart_tv,
                created_at, updated_at,
                CASE WHEN locked_until > NOW() THEN locked_until ELSE NULL END AS locked_until
         FROM market_users ORDER BY LOWER(username)`
      );
      res.json({ users: rows });
    } catch (error) {
      res.status(500).json({ error: 'Unable to list users' });
    }
  });

  app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const username = normaliseUsername(req.body.username);
    const password = String(req.body.password || '');
    if (!username) return res.status(400).json({ error: 'Username must use 1-40 letters, numbers, dot, dash, or underscore' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include a special character' });
    }
    try {
      await ensureTables(pool);
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await pool.query(
        `INSERT INTO market_users (username, password, failed_attempts, locked_until, updated_at)
         VALUES ($1, $2, 0, NULL, NOW())
         RETURNING LOWER(username) AS username, created_at, updated_at`,
        [username, hash]
      );
      res.status(201).json({ user: rows[0] });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Username already exists' });
      console.error('create user failed:', error);
      res.status(500).json({ error: 'Unable to create user' });
    }
  });

  app.put('/api/admin/users/:username/password', requireAdmin, async (req, res) => {
    const username = normaliseUsername(req.params.username);
    const password = String(req.body.password || '');
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include a special character' });
    }
    try {
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        `UPDATE market_users
         SET password = $1, failed_attempts = 0, locked_until = NULL, updated_at = NOW()
         WHERE LOWER(username) = $2`,
        [hash, username]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
      res.json({ user: publicUser(username) });
    } catch (error) {
      console.error('reset password failed:', error);
      res.status(500).json({ error: 'Unable to reset password' });
    }
  });

  // Per-user chart defaults, set by the admin for everyone.
  //   reviewChartCd  - switch to ChartDirector automatically when a closed
  //                    trade is opened for review (fills + full history).
  //   tradingChartTv - use the TradingView-style interactive chart for normal
  //                    trading; off means ChartDirector everywhere.
  app.put('/api/admin/users/:username/chart-prefs', requireAdmin, async (req, res) => {
    const username = normaliseUsername(req.params.username);
    if (!username) return res.status(400).json({ error: 'Username is invalid' });
    // Each flag is optional; an omitted one keeps its current value rather
    // than being coerced to false.
    const hasReview = req.body.reviewChartCd !== undefined;
    const hasTrading = req.body.tradingChartTv !== undefined;
    if (!hasReview && !hasTrading) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    try {
      await ensureTables(pool);
      const { rows } = await pool.query(
        `UPDATE market_users SET
           review_chart_cd  = CASE WHEN $2::boolean THEN $3::boolean ELSE review_chart_cd END,
           trading_chart_tv = CASE WHEN $4::boolean THEN $5::boolean ELSE trading_chart_tv END,
           updated_at = NOW()
         WHERE LOWER(username) = $1
         RETURNING LOWER(username) AS username, risk_per_trade, training_risk_per_trade,
                   review_chart_cd, trading_chart_tv`,
        [username, hasReview, Boolean(req.body.reviewChartCd), hasTrading, Boolean(req.body.tradingChartTv)]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json({ user: publicUser(rows[0].username, rows[0].risk_per_trade,
        rows[0].training_risk_per_trade, rows[0].review_chart_cd, rows[0].trading_chart_tv) });
    } catch (error) {
      console.error('update chart prefs failed:', error);
      res.status(500).json({ error: 'Unable to update chart preferences' });
    }
  });
}

module.exports = {
  authenticate,
  ensureTables,
  normaliseUsername,
  registerProtectedAuthRoutes,
  registerPublicAuthRoutes,
  validPassword,
};
