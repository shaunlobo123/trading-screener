require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { ensureTables, normaliseUsername, validPassword } = require('./auth');

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

async function main() {
  const username = normaliseUsername(process.argv[2]);
  const password = String(process.argv[3] || '');
  if (!username || !validPassword(password)) {
    throw new Error('Usage: node createuser.js <username> <password-with-8+-characters-and-a-special-character>');
  }
  await ensureTables(pool);
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO market_users (username, password, failed_attempts, locked_until, updated_at)
     VALUES ($1, $2, 0, NULL, NOW())
     ON CONFLICT (username)
     DO UPDATE SET password = EXCLUDED.password, failed_attempts = 0,
                   locked_until = NULL, updated_at = NOW()
     RETURNING LOWER(username) AS username`,
    [username, hash]
  );
  console.log(`User ready: ${rows[0].username}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
