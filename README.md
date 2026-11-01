# Clinic booking API

An API for booking clinic appointment slots, plus a small web page that uses it. Built for the Koya Cohort 4 assessment (Task 1), following the spec at koyaacademy.com/assessment-api.

**Stack:** Node.js + Express 5, PostgreSQL (Neon), deployed on Vercel. The web page is one plain HTML file with no framework.

## What's done

| Level | What | How |
|---|---|---|
| 1 | List slots, book, look up a booking, reset | `GET /slots`, `POST /bookings`, `GET /bookings/:id`, `POST /reset` |
| 2 | API key, validation | `X-API-Key` checked before anything else (401). Missing/empty fields and bad emails are 400s, an unknown slot is 404, and a slot that has started is 400. Name and email are trimmed, and email is stored lower-case. |
| 3 | No double booking, cancel | The slot row is locked (`SELECT … FOR UPDATE`) while booking, and a partial unique index allows only one `confirmed` booking per slot. `DELETE /bookings/:id` cancels and frees the slot. |
| 4 | Idempotent retries, paging | `Idempotency-Key` is claimed in the same transaction as the booking, and the response is saved and replayed. Same key with a different body is 422. `GET /bookings?email=` uses cursor paging. |
| 5 | Rate limiting | Max 5 attempts per email per minute, failed ones included, counted in Postgres. The 6th gets 429 with `Retry-After`. The public web routes also allow 10 attempts per IP per minute, so changing email doesn't get around the limit. |

All state lives in Postgres, not in memory, so it works on serverless and across multiple instances.

## How the tricky parts work

**Two people booking the same slot at the same moment.** Booking runs in a transaction that starts with `SELECT … FROM slots WHERE id = $1 FOR UPDATE`. The second request waits at that line until the first commits, then sees the slot is taken and gets 409. As a backstop, the database has a unique index on `bookings(slot_id) WHERE status = 'confirmed'`, so even a bug in the code couldn't create two confirmed bookings for one slot. Cancelled bookings don't count, so a cancelled slot can be booked again.

**Retries (Idempotency-Key).** The key is inserted into `idempotency_keys` inside the booking transaction. If the same key arrives twice at once, the second insert waits for the first transaction, then finds the saved response and returns it, with the same status and the same booking id. The request body is hashed, so reusing a key with a different body returns 422. Error responses (like a 409) are saved too, so a retry gets the same answer.

**Rate limiting.** Each attempt is a row in `booking_attempts`. An advisory lock per email or IP (`pg_advisory_xact_lock`) makes concurrent attempts count one at a time, so a burst can't sneak past the limit. `Retry-After` is the time until the oldest attempt in the window expires. The check runs after the idempotency key is claimed, so retries of the same request don't count as new attempts, even when they arrive at the same moment. A 429 isn't saved against the key, so a retry after the wait can still succeed.

**Paging.** Bookings have an increasing `seq` column. The cursor is that number, base64-encoded, and the next page is `WHERE seq > cursor`. One extra row is fetched to tell whether there's another page, and `next_cursor` is `null` on the last one.

## The web page and the API key

The page at `/` lets a patient see available slots (filterable by doctor), book one, see the confirmation, and look up or cancel a booking by ID.

Putting the API key in the page's JavaScript would leak it to anyone who opens dev tools. Instead, the page calls `/web/*`, which runs the same handlers without the key check. Because those routes are public, they only do what a patient needs. There's no reset and no listing by email, since anyone who knew a patient's email could otherwise see their bookings and get the IDs needed to cancel them. Booking IDs are random UUIDs, so they can't be guessed. The keyed API is for other systems; the page is the public patient-facing part.

## Running locally

```bash
npm install
cp .env.example .env      # set DATABASE_URL and API_KEY
npm run db:setup          # creates tables
npm run dev               # http://localhost:3000
npm run seed              # loads 90 days of demo slots
npm run check             # runs every level of the spec against the API
```

`npm run check` and `npm run seed` both call `/reset`, which wipes bookings. Set `BASE_URL` to point them at a deployed copy.

## Project layout

```
src/app.js        Express setup, API key check, error handling
src/routes.js     endpoint handlers
src/bookings.js   booking, idempotency and rate limit logic
src/db.js         Postgres pool + transaction helper
schema.sql        tables and indexes
public/index.html the web page
api/index.js      Vercel entry point
scripts/          db setup, demo seed data, end-to-end checks
```
