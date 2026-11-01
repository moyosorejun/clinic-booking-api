const crypto = require('crypto');
const { pool, withTransaction } = require('./db');

const MAX_ATTEMPTS_PER_MINUTE = 5;
const MAX_WEB_ATTEMPTS_PER_MINUTE = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// No 0, O, 1 or I, which are easy to mix up when reading a code out.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 10;

const formatBookingId = (code) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;

// Short enough to read out, but with about a quadrillion possibilities, because
// on the public page knowing the ID is what lets someone cancel a booking.
function newBookingId() {
  let code = '';
  for (let i = 0; i < ID_LENGTH; i++) code += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return formatBookingId(code);
}

// Accepts an ID however a patient typed it: lower case, spaces, no dashes.
function normalizeBookingId(id) {
  const code = id.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === ID_LENGTH ? formatBookingId(code) : code;
}

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

function validateBooking(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'request body must be a JSON object';
  }
  for (const field of ['slot_id', 'name', 'email']) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') {
      return `${field} is required`;
    }
  }
  if (!EMAIL_RE.test(body.email.trim())) return 'email is not valid';
  return null;
}

// Books a slot using an open transaction. Returns { status, body }.
async function bookSlot(client, body) {
  const problem = validateBooking(body);
  if (problem) return { status: 400, body: { error: problem } };

  const name = body.name.trim();
  const email = body.email.trim().toLowerCase();

  // FOR UPDATE locks the slot row, so two requests for the same slot
  // queue up here instead of both seeing it as free.
  const { rows: slots } = await client.query(
    'SELECT id, start_time FROM slots WHERE id = $1 FOR UPDATE',
    [body.slot_id]
  );
  const slot = slots[0];
  if (!slot) return { status: 404, body: { error: 'slot not found' } };
  if (slot.start_time <= new Date()) {
    return { status: 400, body: { error: 'slot has already started' } };
  }

  const { rowCount: taken } = await client.query(
    "SELECT 1 FROM bookings WHERE slot_id = $1 AND status = 'confirmed'",
    [slot.id]
  );
  if (taken) return { status: 409, body: { error: 'slot is already booked' } };

  const { rows } = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
    [newBookingId(), slot.id, name, email]
  );
  return { status: 201, body: toBooking(rows[0]) };
}

function hashBody(body) {
  const sorted = body && typeof body === 'object' ? Object.keys(body).sort() : undefined;
  return crypto.createHash('sha256').update(JSON.stringify(body ?? null, sorted)).digest('hex');
}

async function findIdempotencyKey(key) {
  const { rows } = await pool.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
    [key]
  );
  return rows[0] || null;
}

// Creates a booking. With an idempotency key, the key is claimed in the same
// transaction as the booking: a concurrent request with the same key blocks on
// the INSERT until this one commits, then reads back the saved response. Rate
// limits are checked after the claim, so those waiting retries don't count as
// new attempts. Pass ip to also limit by caller (the public web page does).
async function createBooking(body, idempotencyKey, requestHash, ip) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      const claimed = await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
         VALUES ($1, $2, 0, '{}') ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, requestHash]
      );
      if (claimed.rowCount === 0) {
        const { rows } = await client.query(
          'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
          [idempotencyKey]
        );
        return { saved: rows[0] };
      }
    }

    const retryAfter = await checkRateLimits(client, body, ip);
    if (retryAfter) {
      // Not an answer to replay: free the key so a later retry can go through.
      if (idempotencyKey) {
        await client.query('DELETE FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
      }
      return { status: 429, body: { error: 'too many booking attempts, try again later' }, retryAfter };
    }

    const result = await bookSlot(client, body);

    if (idempotencyKey) {
      await client.query(
        'UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1',
        [idempotencyKey, result.status, result.body]
      );
    }
    return result;
  });
}

// Returns 0 if the attempt is allowed, otherwise the seconds to wait. The IP
// goes first so a blocked caller doesn't use up someone else's email limit.
async function checkRateLimits(client, body, ip) {
  if (ip) {
    const wait = await recordAttempt(client, `ip:${ip}`, MAX_WEB_ATTEMPTS_PER_MINUTE);
    if (wait) return wait;
  }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return email ? recordAttempt(client, `email:${email}`, MAX_ATTEMPTS_PER_MINUTE) : 0;
}

// Records an attempt against rateKey. Returns 0 if allowed, otherwise the
// number of seconds until the oldest attempt in the window expires.
async function recordAttempt(client, rateKey, max) {
  // One lock per key so simultaneous attempts are counted one at a time.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [rateKey]);
  await client.query(
    "DELETE FROM booking_attempts WHERE rate_key = $1 AND attempted_at <= clock_timestamp() - interval '60 seconds'",
    [rateKey]
  );
  const { rows } = await client.query(
    `SELECT count(*)::int AS attempts,
            ceil(extract(epoch FROM min(attempted_at) + interval '60 seconds' - clock_timestamp()))::int AS wait
     FROM booking_attempts WHERE rate_key = $1`,
    [rateKey]
  );
  if (rows[0].attempts >= max) return Math.max(1, rows[0].wait);

  await client.query('INSERT INTO booking_attempts (rate_key) VALUES ($1)', [rateKey]);
  return 0;
}

module.exports = {
  normalizeBookingId,
  toBooking,
  hashBody,
  findIdempotencyKey,
  createBooking,
};
