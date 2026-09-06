# AzmSquad Customer Service Platform

A standalone customer-service web app (Talabat-live-chat style): customers sign up, log in, and either start a live chat (AI agent first, escalates to a human) or submit a ticket (answered by a human agent, delivered by email). Admins manage agents, configuration, and have full visibility.

- **What to build:** [`USER_STORIES.md`](./USER_STORIES.md) — the full backlog, organized by squad-kit feature.
- **How things are built here:** [`CLAUDE.md`](./CLAUDE.md) — stack, conventions, and scope notes. Read this before implementing any story.
- **Need a populated database?** Don't hand-create test accounts/tickets — run `npm run seed:import-demo-data` in `backend/` (after MongoDB is up) to instantly load a realistic, committed dataset. See "Demo data" below — **read that section before seeding or resetting the database for any reason**, including as an AI coding agent set up to work in this repo.

## Repo layout

```
backend/    Node.js + Express + MongoDB + Socket.io API and real-time server
frontend/   Next.js app (separate service, talks to backend over REST + Socket.io)
```

## Running locally

```bash
# Backend
cd backend
cp .env.example .env   # fill in MongoDB URI, JWT secret, Gemini API key, SMTP creds
npm install
npm run dev             # http://localhost:4000 — try GET /api/v1/health

# Frontend (separate terminal)
cd frontend
cp .env.local.example .env.local
npm install
npm run dev             # http://localhost:3000
```

Requires a running MongoDB instance (local `mongod`, Docker, or a free-tier Atlas cluster) for `MONGODB_URI`, and a [Google AI Studio](https://aistudio.google.com/) API key for `GEMINI_API_KEY` (free tier).

## Demo data

> **If you (human or AI agent) just cloned this repo and need a working database to test/demo against, this is the fastest path — don't hand-write test users/tickets/chats, and don't call Gemini to generate filler content.**

```bash
cd backend
npm run seed:import-demo-data   # wipes the DB, loads the committed demo dataset — no Gemini key, no network call
```

This is safe to run any time the database needs to be reset back to a known, realistic state — it always wipes first, then reloads the exact same committed dataset. The dataset itself lives in the repo at `backend/seed-data/*.json` (one JSON file per MongoDB collection — this is the practical equivalent of "the database is checked into the repo," since MongoDB has no single portable database file the way SQLite does); `import-demo-data.ts` just reads those files back in. Guarded to refuse running with `NODE_ENV=production`.

What you get: 30 accounts (2 admins, 1 subadmin, 8 agents, ~19 customers — full email/password list printed if you run `seed:demo-full` instead, or see `SEED_DEMO_DATA_PROMPT.md`), 10 ticket lifecycle scenarios with realistic status/category/priority/SLA history, several live chats (two 30+ message threads specifically for testing AI ticket/chat summarization against real long history), and FAQs/help articles across every knowledge-base category. The `/login` page's "Fill demo credentials" and "Fill admin credentials" buttons work against this dataset out of the box (`demo@azmsquad.com` / `Demo@12345` and `admin@azmsquad.com` / `Admin@12345`).

To change *what* gets seeded (add a scenario, more accounts, etc.) rather than just reload the existing dataset: edit `backend/scripts/seed-demo-full.ts`, then run `npm run seed:demo-full` — this regenerates the data from scratch **and rewrites** `backend/seed-data/*.json`, which you then commit. Full spec, rationale, and implementation notes: [`SEED_DEMO_DATA_PROMPT.md`](./SEED_DEMO_DATA_PROMPT.md).

## Using squad-kit

Each feature in `USER_STORIES.md` maps to one squad-kit feature folder:

```bash
squad new-story <feature-slug> --title "<Story Title>"
```

Paste that story's **User Story** + **Acceptance Criteria** into the generated `intake.md`, then run squad-kit's plan/execute steps. Recommended feature order is in `USER_STORIES.md`'s intro and repeated in `CLAUDE.md`.
