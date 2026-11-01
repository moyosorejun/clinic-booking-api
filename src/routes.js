const express = require('express');
const { pool, withTransaction } = require('./db');
const {
  toBooking,
  hashBody,
  findIdempotencyKey,
  createBooking,
} = require('./bookings');

const isText = (v) => typeof v === 'string' && v.trim() !== '';

// --- Level 1: reset ---------------------------------------------------------

async function reset(req, res) {
  const slots = req.body?.slots;
  if (!Array.isArray(slots)) {
    return res.status(400).json({ error: 'slots must be an array' });
  }
  const ids = new Set();
  for (const s of slots) {
    if (!s || !isText(s.id) || !isText(s.provider) || !isText(s.start) || !isText(s.end)) {
      return res.status(400).json({ error: 'each slot needs id, provider, start and end' });
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      return res.status(400).json({ error: `slot ${s.id} has an invalid start or end` });
    }
    if (ids.has(s.id)) return res.status(400).json({ error: `duplicate slot id ${s.id}` });
    ids.add(s.id);
  }

  await withTransaction(async (client) => {
    await client.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
    await client.query(
      `INSERT INTO slots (id, provider, start_time, end_time, start_text, end_text)
       SELECT id, provider, start_text::timestamptz, end_text::timestamptz, start_text, end_text
       FROM json_to_recordset($1::json)
         AS x(id text, provider text, start_text text, end_text text)`,
      [JSON.stringify(slots.map((s) => ({
        id: s.id, provider: s.provider, start_text: s.start, end_text: s.end,
      })))]
    );
  });
  res.json({ ok: true, slots: slots.length });
}

// --- Level 1: list slots -----------------------------------------------------

async function listSlots(req, res) {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_text, s.end_text,
            NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
     FROM slots s
     WHERE $1::text IS NULL OR s.provider = $1
     ORDER BY s.start_time, s.id`,
    [provider]
  );
  res.json({
    slots: rows.map((r) => ({
      id: r.id, provider: r.provider, start: r.start_text, end: r.end_text, available: r.available,
    })),
  });
}

// --- Levels 1-5: book a slot -------------------------------------------------

function sendSaved(res, saved, requestHash) {
  if (saved.request_hash !== requestHash) {
    return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
  }
  return res.status(saved.status_code).json(saved.response);
}

async function postBooking(req, res, ip) {
  const body = req.body;
  const key = req.get('Idempotency-Key');
  const requestHash = key ? hashBody(body) : null;

  // A retry of a finished request gets the original answer straight away.
  if (key) {
    const saved = await findIdempotencyKey(key);
    if (saved) return sendSaved(res, saved, requestHash);
  }

  const result = await createBooking(body, key, requestHash, ip);
  if (result.saved) return sendSaved(res, result.saved, requestHash);
  if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
  res.status(result.status).json(result.body);
}

// --- Level 1: get a booking --------------------------------------------------

async function getBooking(req, res) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'booking not found' });
  res.json(toBooking(rows[0]));
}

// --- Level 3: cancel ---------------------------------------------------------

async function cancelBooking(req, res) {
  const { rows } = await pool.query(
    "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
    [req.params.id]
  );
  if (rows[0]) return res.json(toBooking(rows[0]));

  const { rowCount } = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'booking not found' });
  res.status(409).json({ error: 'booking is already cancelled' });
}

// --- Level 4: a person's bookings, cursor paging -----------------------------

const encodeCursor = (seq) => Buffer.from(String(seq)).toString('base64url');
const decodeCursor = (cursor) => {
  const seq = Buffer.from(cursor, 'base64url').toString();
  return /^\d{1,18}$/.test(seq) ? seq : null; // 18 digits always fits a BIGINT
};

async function listBookings(req, res) {
  const { email, limit: rawLimit, cursor } = req.query;
  if (!isText(email)) return res.status(400).json({ error: 'email is required' });

  let limit = 10;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > 50) {
      return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    }
  }

  let afterSeq = '0';
  if (cursor !== undefined) {
    afterSeq = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (!afterSeq) return res.status(400).json({ error: 'cursor is not valid' });
  }

  // Fetch one extra row to find out whether there's another page.
  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [email.trim().toLowerCase(), afterSeq, limit + 1]
  );
  const page = rows.slice(0, limit);
  res.json({
    bookings: page.map(toBooking),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
  });
}

// Same handlers for the keyed API and for the public web page (see app.js).
// Only the keyed API can reset or list a person's bookings by email, and only
// the public page is limited by IP.
function buildRouter({ isPublic }) {
  const router = express.Router();
  if (!isPublic) {
    router.post('/reset', reset);
    router.get('/bookings', listBookings);
  }
  router.get('/slots', listSlots);
  router.post('/bookings', (req, res) => postBooking(req, res, isPublic ? req.ip : null));
  router.get('/bookings/:id', getBooking);
  router.delete('/bookings/:id', cancelBooking);
  return router;
}

module.exports = { buildRouter };
