const { Pool } = require('pg');
require('dotenv').config({ quiet: true });

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

// Small pool: on Vercel every function instance gets its own pool.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
});

// Run fn inside a transaction, rolling back if it throws.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
