// Runs through every level of the spec against a running API.
//   BASE_URL=http://localhost:3000 API_KEY=... npm run check
// Warning: this calls /reset, which wipes all bookings. Run `npm run seed` after.
require('dotenv').config({ quiet: true });

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures += 1;
}

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-API-Key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

const inDays = (d, h) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + d);
  t.setUTCHours(h, 0, 0, 0);
  return t.toISOString().replace('.000Z', 'Z');
};

const slots = [
  { id: 's3', provider: 'Dr Bello', start: inDays(2, 10), end: inDays(2, 11) },
  { id: 's1', provider: 'Dr Ade', start: inDays(1, 9), end: inDays(1, 10) },
  { id: 's2', provider: 'Dr Ade', start: inDays(1, 11), end: inDays(1, 12) },
  { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`, provider: 'Dr Chi', start: inDays(3 + i, 9), end: inDays(3 + i, 10),
  })),
];

(async () => {
  console.log(`Checking ${BASE}\n`);

  // Level 2: auth
  check('no key -> 401', (await call('GET', '/slots', { key: null })).status === 401);
  check('wrong key -> 401', (await call('GET', '/slots', { key: 'nope' })).status === 401);

  // Level 1
  check('reset -> 200', (await call('POST', '/reset', { body: { slots } })).status === 200);
  let r = await call('GET', '/slots');
  check('slots sorted by start', r.data.slots.map((s) => s.id).slice(0, 3).join() === 'past,s1,s2', JSON.stringify(r.data.slots.slice(0, 3)));
  check('slot start returned unchanged', r.data.slots[1].start === slots[1].start);
  check('slots available', r.data.slots.every((s) => s.available === true));
  r = await call('GET', '/slots?provider=Dr%20Bello');
  check('provider filter', r.data.slots.length === 1 && r.data.slots[0].id === 's3');

  r = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi ', email: ' Ada@Example.com ' } });
  check('book -> 201 confirmed', r.status === 201 && r.data.status === 'confirmed', JSON.stringify(r.data));
  check('name/email trimmed, email lower-cased', r.data.name === 'Ada Obi' && r.data.email === 'ada@example.com');
  const booking = r.data;
  r = await call('GET', `/bookings/${booking.id}`);
  check('get booking', r.status === 200 && r.data.id === booking.id);
  check('unknown booking -> 404', (await call('GET', '/bookings/nope')).status === 404);
  r = await call('GET', '/slots');
  check('booked slot unavailable', r.data.slots.find((s) => s.id === 's1').available === false);

  // Level 2: validation
  const v = (body) => call('POST', '/bookings', { body }).then((x) => x.status);
  check('missing name -> 400', (await v({ slot_id: 's2', email: 'v1@x.com' })) === 400);
  check('empty name -> 400', (await v({ slot_id: 's2', name: '   ', email: 'v2@x.com' })) === 400);
  check('bad email -> 400', (await v({ slot_id: 's2', name: 'V', email: 'not-an-email' })) === 400);
  check('missing slot_id -> 400', (await v({ name: 'V', email: 'v3@x.com' })) === 400);
  check('unknown slot -> 404', (await v({ slot_id: 'zzz', name: 'V', email: 'v4@x.com' })) === 404);
  check('past slot -> 400', (await v({ slot_id: 'past', name: 'V', email: 'v5@x.com' })) === 400);
  check('bad JSON -> 400', (await call('POST', '/bookings', { body: '{nope' })).status === 400);
  r = await call('POST', '/bookings', { body: { name: 'V' } });
  check('errors are {error}', typeof r.data?.error === 'string');

  // Level 3: double booking, including simultaneous requests
  check('already booked -> 409', (await v({ slot_id: 's1', name: 'B', email: 'b@x.com' })) === 409);
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call('POST', '/bookings', { body: { slot_id: 's3', name: 'Racer', email: `racer${i}@x.com` } })));
  const wins = race.filter((x) => x.status === 201).length;
  const lost = race.filter((x) => x.status === 409).length;
  check('20 simultaneous bookings -> exactly one 201', wins === 1 && lost === 19, `201s=${wins} 409s=${lost}`);

  r = await call('DELETE', `/bookings/${booking.id}`);
  check('cancel -> 200 cancelled', r.status === 200 && r.data.status === 'cancelled');
  check('cancel again -> 409', (await call('DELETE', `/bookings/${booking.id}`)).status === 409);
  check('cancel unknown -> 404', (await call('DELETE', '/bookings/nope')).status === 404);
  r = await call('GET', '/slots');
  check('cancelled slot is free again', r.data.slots.find((s) => s.id === 's1').available === true);
  check('rebook freed slot -> 201', (await v({ slot_id: 's1', name: 'C', email: 'c@x.com' })) === 201);

  // Level 4: idempotency
  const idem = { 'Idempotency-Key': `k-${Date.now()}` };
  const body = { slot_id: 's2', name: 'Idem', email: 'idem@x.com' };
  const first = await call('POST', '/bookings', { body, headers: idem });
  const again = await call('POST', '/bookings', { body, headers: idem });
  check('same key + body -> same response', first.status === 201 && again.status === 201 && first.data.id === again.data.id);
  check('different body, same key -> 422', (await call('POST', '/bookings', { body: { ...body, name: 'Other' }, headers: idem })).status === 422);
  const idem2 = { 'Idempotency-Key': `k2-${Date.now()}` };
  const body2 = { slot_id: 'p0', name: 'Idem2', email: 'idem2@x.com' };
  const sameMoment = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/bookings', { body: body2, headers: idem2 })));
  const ids = new Set(sameMoment.map((x) => x.data?.id));
  check('simultaneous retries -> one booking', sameMoment.every((x) => x.status === 201) && ids.size === 1, JSON.stringify(sameMoment.map((x) => x.status)));
  const idem3 = { 'Idempotency-Key': `k3-${Date.now()}` };
  const conflict1 = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'L', email: 'late@x.com' }, headers: idem3 });
  const conflict2 = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'L', email: 'late@x.com' }, headers: idem3 });
  check('replayed error keeps its status', conflict1.status === 409 && conflict2.status === 409);

  // Level 4: paging
  for (let i = 1; i <= 5; i++) { // 5 = the per-minute limit
    await call('POST', '/bookings', { body: { slot_id: `p${i}`, name: 'Pager', email: i % 2 ? 'pager@x.com' : 'PAGER@x.com' } });
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    r = await call('GET', `/bookings?email=Pager@X.com&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...r.data.bookings.map((b) => b.slot_id));
    cursor = r.data.next_cursor;
    pages += 1;
  } while (cursor && pages < 10);
  check('paging: 5 bookings over 3 pages, oldest first', seen.join() === 'p1,p2,p3,p4,p5' && pages === 3, `${seen} pages=${pages}`);
  check('limit=0 -> 400', (await call('GET', '/bookings?email=a@x.com&limit=0')).status === 400);
  check('limit=51 -> 400', (await call('GET', '/bookings?email=a@x.com&limit=51')).status === 400);
  check('limit=abc -> 400', (await call('GET', '/bookings?email=a@x.com&limit=abc')).status === 400);
  r = await call('GET', '/bookings?email=a@x.com');
  check('no bookings -> empty page, null cursor', r.status === 200 && r.data.bookings.length === 0 && r.data.next_cursor === null);

  // Level 5: rate limit
  const spam = `spam${Date.now()}@x.com`;
  const statuses = [];
  let lastHeaders;
  for (let i = 0; i < 6; i++) {
    const x = await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'S', email: spam } });
    statuses.push(x.status);
    lastHeaders = x.headers;
  }
  check('5 attempts allowed (failed ones count)', statuses.slice(0, 5).every((s) => s === 404), statuses.join());
  check('6th attempt -> 429', statuses[5] === 429, statuses.join());
  const retry = lastHeaders.get('retry-after');
  check('Retry-After in whole seconds', /^\d+$/.test(retry || '') && Number(retry) >= 1 && Number(retry) <= 60, retry);
  check('other emails unaffected', (await v({ slot_id: 'zzz', name: 'S', email: `other${Date.now()}@x.com` })) === 404);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
