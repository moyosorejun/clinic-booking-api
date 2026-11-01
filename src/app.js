const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { buildRouter } = require('./routes');

const app = express();
app.set('trust proxy', true);

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
// Rate limiting still applies there, and /web has no reset.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.use('/web', express.json(), buildRouter({ includeReset: false }));

// The API: key checked before anything else, including body parsing.
app.use(requireApiKey, express.json(), buildRouter({ includeReset: true }));

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body is not valid JSON' });
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
