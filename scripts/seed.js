// Loads 90 days of demo slots (wipes existing bookings). Long enough that the
// page still has free slots whenever someone reviews it.
//   BASE_URL=https://your-app.vercel.app API_KEY=... npm run seed
require('dotenv').config({ quiet: true });

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const doctors = ['Dr Ade', 'Dr Bello', 'Dr Chioma'];

const slots = [];
for (let d = 1; d <= 90; d++) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + d);
  if ([0, 6].includes(date.getUTCDay())) continue; // weekdays only
  doctors.forEach((provider, i) => {
    for (const hour of [8, 9, 10, 12, 13, 14].slice(i, i + 4)) {
      for (const min of [0, 30]) {
        const start = new Date(date);
        start.setUTCHours(hour, min, 0, 0);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        const iso = (t) => t.toISOString().replace('.000Z', 'Z');
        slots.push({ id: `${provider.split(' ')[1].toLowerCase()}-${iso(start).slice(0, 16)}`, provider, start: iso(start), end: iso(end) });
      }
    }
  });
}

fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY },
  body: JSON.stringify({ slots }),
})
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((err) => { console.error(err); process.exit(1); });
