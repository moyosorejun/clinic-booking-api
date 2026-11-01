// Creates the tables. Safe to run more than once.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Database ready.');
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
