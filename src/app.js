const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { buildRouter } = require('./routes');

const app = express();
app.set('trust proxy', 1); // only the host's own proxy, so callers can't fake their IP

function sameSecret(a, b) {
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const given = req.get('X-API-Key') || '';
  if (!expected || !sameSecret(given, expected)) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
}

// The web page. Patients shouldn't need (or be able to see) the API key, so
// the page calls /web/*, which runs the same handlers without the key check.
// It's limited to what a patient needs: no reset and no listing by email, plus
// a per-IP rate limit on top of the per-email one.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.use('/web', express.json(), buildRouter({ isPublic: true }));

// The API: key checked before anything else, including body parsing.
// A larger body limit than /web, because /reset can carry months of slots.
app.use(requireApiKey, express.json({ limit: '2mb' }), buildRouter({ isPublic: false }));

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body is too large' });
  }
  if (err.code === '23505') {
    // unique index backstop: a confirmed booking already exists for the slot
    return res.status(409).json({ error: 'slot is already booked' });
  }
  if (err.code === '22007' || err.code === '22008') {
    return res.status(400).json({ error: 'invalid date' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
