# CLAUDE.md — Project Context for AI-Assisted Development

This file is read automatically by Claude Code (and should be treated as authoritative context by any AI agent working in this repo, including squad-kit's planner). It's the "ground rules" file: what this project is, what stack it's built on, and the conventions every story's implementation should follow. `USER_STORIES.md` is the "what to build" backlog; this file is the "how things are built here" reference. Read both before planning or implementing any story.

## What this project is

A standalone customer service web platform (not attached to any product/e-commerce catalog — think of the support/live-chat experience inside an app like Talabat, built on its own). Customers sign up, log in, and either start a live chat or submit a ticket (a written comment/problem). Live chat is answered first by an AI agent and escalates to a human agent when needed; tickets are answered by a human agent and delivered by email. Admins manage agents, configuration, and have full visibility across the system.

**Personas:** Customer · Human Agent · Admin · AI Agent (a system actor powered by Google Gemini — not a login-able account)

## Tech stack (decided — follow this, don't introduce alternatives without discussion)

- **Backend:** Node.js + Express, in `backend/`, written in **TypeScript** (compiled via `tsc`, run in dev via `tsx watch`). Prefer explicit interfaces for models, request bodies, and service inputs/outputs over `any`. Mongoose documents are typed via `Document`-extending interfaces (see `src/models/`).
- **Database:** MongoDB via Mongoose. Chosen over SQLite because the core of this app is high-frequency real-time chat writes and flexible conversation/ticket documents, which fit MongoDB's document model better than a single-writer relational file.
- **Real-time:** Socket.io, mounted on the same Express HTTP server, for live chat.
- **Auth:** JWT-based sessions (issued by the backend), passwords hashed with bcrypt. Roles: `customer`, `agent`, `admin`. The AI agent is not a user account — it's invoked server-side as a service. See "Frontend auth (session handling)" below for how the frontend carries this session — the JWT is never stored in browser-readable storage.
- **AI integration:** Google Gemini API, free tier, via the `@google/generative-ai` SDK. The Gemini API key lives only in backend environment variables — never sent to or called from the frontend. Used for: the customer-facing chat bot (first responder in live chat), ticket/chat summaries, suggested replies for agents, automatic categorization, and suggested knowledge-base solutions. Wrap every Gemini call with a timeout and a graceful fallback message — never let a customer-facing flow hang on an external API call.
- **Email:** Nodemailer, SMTP credentials from environment variables, used for ticket acknowledgments and agent replies delivered by email.
- **Frontend:** Next.js (App Router) + React, written in **TypeScript** (`.tsx`/`.ts`), in `frontend/`, as a separate app/service from the backend — not a Next.js monolith. Talks to the backend over REST (via its own server-side BFF layer — see below, not directly from browser JS for anything authenticated) and a Socket.io client connection for live chat.
- **i18n:** The customer-facing UI (and ideally agent/admin UI) must support Arabic and English, including right-to-left layout for Arabic. Don't hardcode English-only strings in components — route all user-facing text through the i18n layer from the start (the library is already wired in; see "i18n (internationalization)" below).

## Frontend auth (session handling)

Neither the access token nor the refresh token is ever stored in browser-readable storage (no `localStorage`, no client-readable cookie) — both live only in `httpOnly` cookies (`SESSION_COOKIE` and `REFRESH_COOKIE` in `frontend/lib/auth.ts`), set by the frontend's own Backend-for-Frontend (BFF) layer. This is the Next.js-documented pattern for this exact situation (separate backend origin, App Router): [nextjs.org/docs/app/guides/backend-for-frontend](https://nextjs.org/docs/app/guides/backend-for-frontend).

- **Two cookies, two lifetimes.** The access token (JWT, `{ sub, role, name }`) is short-lived (~15 min); the refresh token (opaque, deterministically HMAC-chained on rotation) is long-lived (~30 days), backed by a `RefreshFamily` document per login session. Full design, threat model, and the concurrency/reuse-detection reasoning: `.squad/plans/auth/02-story-login-customer-agent-or-admin.md`, "Addendum: Refresh token mechanism" — read that before touching anything auth-related, not just this summary.
- **Auth handshake:** Server Actions, not Route Handlers — `frontend/app/login/actions.ts` (`login`) and `frontend/app/register/actions.ts` (`register`) call the real backend (`POST /api/v1/auth/...`) server-side, then set both `httpOnly` cookies via `lib/session.ts`'s `setSessionCookies()` and `redirect()` on success. `frontend/app/actions.ts` (`logout`) best-effort revokes server-side (`POST /auth/logout`) then clears both cookies unconditionally — local logout must succeed even if that call fails. The backend's JSON response (which includes the raw tokens) never reaches the browser directly. (An earlier version of this used Route Handlers under `app/api/auth/*` called via client-side `fetch` — replaced with Server Actions for consistency with every other mutation in the app; see "Forms backed by Server Actions" below before reintroducing that pattern.)
- **Silent refresh — the access cookie disappearing on its own is the normal case, not an error.** Its short maxAge means it routinely expires mid-session while the refresh cookie is still valid. Server Components can't refresh themselves (`cookies().set()` throws outside a Server Action/Route Handler) — on a 401 they `redirect()` to `frontend/app/api/session/refresh/route.ts`, the one place that can rotate the tokens and rewrite the cookies, then redirect back (see `frontend/app/settings/page.tsx` for the reference pattern, including the one-shot loop guard). Server Actions *can* write cookies directly, so they refresh inline and retry once instead of redirecting — a redirect there would silently drop whatever the user was submitting (see `frontend/app/settings/actions.ts`).
- **Route protection:** `frontend/proxy.ts` (Next.js 16's renamed `middleware.ts` — the file convention is `proxy.ts`, exported function is `proxy`, **not** `middleware`; using the old name is deprecated and will warn at build time) does a presence-only check on **either** cookie (not just the access token, for the reason above) and redirects unauthenticated requests before a protected page renders. This is a UX convenience, not the real security boundary — keep it a "thin proxy" (redirects/rewrites only) per Next.js 16's guidance, not JWT verification; the backend's `requireAuth` is what actually verifies the token's signature, on every request, regardless of what the proxy did.
- **Authenticated pages:** Server Components that `await cookies()`, read the session cookie, and call the backend server-side (`Authorization: Bearer <token>`) — see `frontend/app/settings/page.tsx` for the pattern. Never pass the token down to a Client Component.
- **Every mutation from a Client Component** — authenticated or not (login/register included) — goes through a Server Action (`"use server"`) that reads the cookie server-side (when one exists yet) and calls the backend, never a client-side `fetch` to the backend's origin. `useActionState` (React 19) wires a Server Action to a form for pending/error/success state.
- **Persistent nav:** `frontend/components/SiteHeader.tsx`, rendered from `RootLayout`, appears on every page. Signed-out: Log in/Sign up. Signed-in: an avatar-initial dropdown (`frontend/components/UserMenu.tsx`, the display name comes from the JWT's `name` claim via `frontend/lib/jwt.ts`'s `peekJwtPayload()` — an unverified peek used only for this UI decision, never for authorization) holding Profile, the theme toggle, the language toggle, and Log out — not separate nav buttons. A staff-only "Customers" link (role read the same unverified way) also lives here. This exists so no authenticated action ever requires navigating to `/` first — don't build a page that's only reachable via another page's ad hoc links.
- Server-to-server calls (a Server Component/Server Action calling the Express backend) aren't subject to browser CORS — no `credentials`/CORS config needed for that leg; the backend's `cors()` config only matters if something ever calls it directly from a browser again, which authenticated flows should not do.

## Forms backed by Server Actions

Two gotchas that cost real debugging time — apply both to every new form, not just auth:

- **Use controlled inputs (`value`/`onChange` backed by `useState`), never bare `defaultValue`/uncontrolled `<input>`s.** React resets uncontrolled form fields to empty after *every* Server Action submission — success **or error**. A failed submission (e.g. wrong password) silently blanks every field, so a user who only corrects the one field they think is wrong ends up resubmitting with the *other* fields empty — which is exactly what happened during Story 1/2 testing: a correct password resubmitted after a failed attempt kept failing because the email field had silently gone blank. See `frontend/app/login/LoginForm.tsx` for the pattern.
- **Validate with `zod` inside the Server Action itself** (`safeParse`, return per-field errors from `.flatten().fieldErrors` in the action's state) — don't rely on HTML5 `required`/`type`/`minLength` alone. Native attributes are a UX nicety, not validation: they're trivially bypassed (JS disabled, a raw POST, a browser extension) and give no localized/i18n'd message. The action's state shape should carry `fieldErrors` alongside the existing top-level `error`, and the form should render both — see `frontend/app/login/actions.ts` / `LoginForm.tsx`.

## i18n (internationalization)

The frontend uses **next-intl** (`frontend/i18n/request.ts`, `frontend/messages/en.json`, wired via `withNextIntl(...)` in `frontend/next.config.js` and `NextIntlClientProvider` in `frontend/app/layout.tsx`). This was set up early — not deferred to Story 50 — specifically so no component ever needs its hardcoded strings retrofitted into message keys after the fact; only the retrofit for the *first* few components (home, login, register, settings) had to happen once, when this was introduced.

- **Every new component with user-facing text adds a key to `frontend/messages/en.json`** and reads it with `useTranslations("SectionName")` (Client Components) or `getTranslations("SectionName")` (Server Components, Server Actions, Route Handlers) from `next-intl`/`next-intl/server`. Never inline an English string directly in JSX.
- **Story 50 ("Bilingual Arabic & English UI") is done**, ahead of its place in the recommended build order — built alongside auth/customer-management work rather than waiting for the platform feature's turn. `frontend/messages/ar.json` translates every key in `en.json`; locale is resolved server-side in `frontend/i18n/request.ts` from a cookie (`LOCALE_COOKIE`, `frontend/lib/locale.ts`) — no `[locale]` URL routing segment, exactly as originally scoped ("Story 50 should not need to touch any component other than the locale-detection/switching mechanism"). `RootLayout` resolves `dir`/`lang` server-side from that same cookie (`frontend/app/layout.tsx`); switching locale is a menu item in `frontend/components/UserMenu.tsx` (sets the cookie, `router.refresh()`s). **When adding a new key to `en.json`, add the matching key to `ar.json` in the same change** — don't let them drift apart now that both are live.
- Keep section names in `en.json` matching the feature/page they belong to (`Home`, `Login`, `Register`, `Settings`, ...) so the file stays navigable as it grows across all 51 stories.

## SEO (frontend pages)

Every new page ships its SEO metadata in the same story that adds the page — not a follow-up pass, for the same reason i18n is handled up front (see above): retrofitting metadata across a growing set of pages later costs far more than adding it once, per page, as it's built.

- **Every page under `frontend/app/` exports page-specific metadata** — `export const metadata: Metadata` for static pages, or `generateMetadata()` for pages whose title/description depends on fetched data (e.g. a future ticket/KB-article detail page). Route it through the same i18n layer as everything else — `getTranslations("SectionName")` inside `generateMetadata()`, with `title`/`description` keys alongside that section's other strings in `frontend/messages/en.json` — never a hardcoded English string. `RootLayout`'s `metadata` export (`frontend/app/layout.tsx`) is only the fallback for pages that don't override it; don't leave every page showing the same generic title.
- **Public, customer-facing pages** (home, login, register, and later any public marketing/knowledge-base page) need real SEO: a distinct `title`/`description` per page, one `<h1>` per page, meaningful heading hierarchy, descriptive link text (not "click here"), and `alt` text on every image.
- **Authenticated/internal pages** (settings, agent workspace, admin, customer profile, ...) aren't meant to be indexed — give them `robots: { index: false, follow: false }` in their `metadata` export rather than skipping metadata entirely (they still want a correct `<title>` for the browser tab/history).
- **Site-wide files** (`frontend/app/robots.ts`, `frontend/app/sitemap.ts`) are platform-feature scope, not per-story — add them once, when the first public page that should actually be crawled exists, and keep the sitemap limited to public routes.

## Dependency freshness policy

- Never pick a package version from training knowledge — it's likely stale. Before adding or upgrading any dependency, check the real npm registry: `npm view <package> version` for the latest, and for anything load-bearing (`next`, `react`, `react-dom`, `mongoose`, `express`, `socket.io`, `typescript`, `tailwindcss`, or anything else central to the stack) also run `npm view <package> dist-tags --json` to confirm you're reading the `latest` tag rather than accidentally picking up `next`/`canary`/`rc`/`beta`.
- Before bumping a load-bearing package, check `npm view <package>@<version> peerDependencies engines --json` and cross-reference against the other side of the stack (backend vs. frontend) and the Node version actually installed (`node --version`). Pick versions that are mutually compatible, not just individually "latest".
- If the newest major of a package requires a higher Node version than what's installed, pin to the newest version compatible with the installed Node instead of forcing the upgrade — document the tradeoff (see "Current pinned exceptions" below) rather than silently downgrading or leaving it unexplained.
- After any dependency bump, run `npm run typecheck` and `npm run build` in `backend/`, and `npm run build` in `frontend/` (both, if the change touches a shared dep like `typescript` or `@types/node`) before considering the upgrade done. Fix any breakage as part of the same change — never leave a half-upgraded lockfile.

### Current pinned exceptions

- **mongoose is pinned to the 8.x line (`^8.24.4`), not the 9.x latest.** mongoose 9.x requires Node `>=20.19.0`; the environment's installed Node is `20.15.0`. mongoose 8.24.4 requires only Node `>=16.20.1` and is otherwise the newest available on that line. Revisit once the installed Node is upgraded to `>=20.19.0`.

## Design system

The frontend uses **shadcn/ui** (Radix primitives + Tailwind v4) — don't introduce another component library or hand-roll primitives that already exist here. Base config lives in `frontend/components.json`; installed primitives are in `frontend/components/ui/`.

- **Add a new primitive** with `npx shadcn@latest add <component>` from `frontend/` — don't hand-write a component shadcn already ships (button, card, badge, avatar, input, textarea, switch, tabs, separator, select, dropdown-menu, table, scroll-area, label are already installed).
- **Theme tokens** live as CSS custom properties in `frontend/app/globals.css` (`:root` / `.dark`), mapped into Tailwind utilities via the `@theme inline` block. Use the token utilities (`bg-primary`, `text-muted-foreground`, `bg-success`, ...) — never hardcode a hex color in a component.
- **Palette:** primary is a warm amber/gold (`--primary: #C17F1F` light / `#C8862E` dark) — changed from an earlier muted violet/indigo, which read as a generic "default AI-generated SaaS" color; amber was chosen deliberately distinct from it. Light-mode neutrals are warm off-white/cream (`--background: #F6F3EE`, cards `#FFFFFF`), not stark white — a pure-white background was tried first and reported as harsh, so surfaces were softened to a cohesive warm-neutral family instead of leaving some elements white and others tinted. There are also dedicated semantic status tokens beyond shadcn's defaults — `--success`/`--success-foreground` (green, "on track" / resolved), `--warning`/`--warning-foreground` (amber, SLA at-risk — deliberately kept visually distinct from `--primary` despite both being in the amber family, since they mean different things), `--destructive`/`--destructive-foreground` (red, SLA breached). Use these three for any SLA/ticket-status indicator so status color stays consistent across the whole app — don't invent new status colors per feature.
- **Dark mode is still the default**, but it's no longer the only option — `frontend/components/UserMenu.tsx` has a real working light/dark toggle. Preference is stored in a plain (non-httpOnly) cookie (`THEME_COOKIE`, `frontend/lib/theme.ts`) and resolved server-side in `RootLayout` before first paint, so there's no flash of the wrong theme; a fresh session with no cookie still defaults to dark. The `:root` (light) tokens are kept in sync with every dark-token change, same as before.
- **Font:** Inter (`next/font/google`, wired in `frontend/app/layout.tsx` as `--font-sans`, weights 400–800) — not Roboto/Geist/Plus Jakarta Sans (an earlier choice, replaced). One font family, no separate display face needed for this dashboard-style UI.
- **RTL is wired up for real now** (Story 50, see "i18n" above) — `RootLayout` resolves the actual `dir`/`lang` from the locale cookie, no longer hardcoded to `"ltr"`/`"en"`. `frontend/components.json`'s `"rtl": true` and the `Direction.Provider` wrapping were already in place for exactly this and needed no changes. Verified end-to-end: full layout mirroring, including logical-corner card shapes (`rounded-ss-*`) flipping to the correct side automatically.
- Two style directions (this shadcn one vs. an Ant Design-style alternative) were mocked up and compared before deciding — shadcn/ui was the chosen direction. Don't reintroduce the Ant Design-style density/table-heavy pattern without discussion.

## Testing

The backend's test runner is **Vitest**, not Jest — introduced by the `auth` feature's Story 3 (role-based access control) plan. `ts-jest` does not work with this project's `typescript@^7.0.2`: it fails to install (peer-dependency range doesn't cover TS 7.x) and, even forced past that, cannot invoke TS7's compiler API at all, so no test would ever run. Vitest transforms TypeScript via `esbuild` — the same tool this project's dev server (`tsx`) already uses — so it has no dependency on TypeScript's compiler API and isn't affected. Config: `backend/vitest.config.ts` (`globals: true`, so `describe`/`it`/`expect` don't need per-file imports), tests under `backend/tests/`, run via `npm test` (`vitest run`). `backend/tsconfig.json`'s `include` covers `tests/**/*.ts` alongside `src/**/*.ts` so `npm run typecheck` actually checks test files. Use `supertest` for HTTP-level route tests against `createApp()` from `backend/src/app.ts`.

No test runner exists in `frontend/` yet — cross that bridge with the same reasoning (esbuild-based tools, matching Next.js's own Turbopack/esbuild toolchain) rather than defaulting to Jest there either.

## Repo layout

```
backend/
  src/
    config/      # DB connection, env loading
    models/      # Mongoose schemas (User, Ticket, Conversation, Message, ...)
    middleware/  # auth (JWT verify + role check), error handling
    routes/      # Express route definitions
    services/    # gemini.service.js, email.service.js — external integrations live here, never called directly from routes/controllers
    sockets/     # Socket.io event handlers for live chat
    app.js       # Express app setup (middleware, routes)
    server.js    # entry point: starts HTTP server + Socket.io
frontend/
  app/           # Next.js App Router pages/layouts
  public/
USER_STORIES.md  # the backlog — source of truth for what to build, organized by squad-kit feature
```

## Conventions

- **Every story that adds or changes a persona-facing backend capability ships its frontend UI in the same story.** "Backend-only, frontend is a later story" is not an acceptable way to scope a story — it was tried once (Stories 1-2, deferring the sign-up/login forms to an unspecified future "customer portal" story that never actually existed), and it left the platform with working auth endpoints and no way for a human to reach them. The only stories allowed to be backend-only are ones with no persona-facing surface at all (e.g. an internal cron job, a webhook receiver, a data-migration script) — anything a customer/agent/admin would need to click through must include the page(s)/component(s) for it, not just the API.
- REST endpoints are versioned under `/api/v1/...` and grouped by resource (`/tickets`, `/conversations`, `/customers`, `/auth`, `/admin/...`).
- Every route that isn't public passes through the `auth` middleware, which verifies the JWT and checks role before the handler runs. Don't re-implement role checks ad hoc inside handlers.
- External integrations (Gemini, email/SMTP) are only ever called from `src/services/`, never directly from a route or socket handler — this keeps them mockable/testable and keeps API keys out of business logic.
- Environment variables are the only place secrets/config live (`.env`, never committed — see `.env.example` for the required keys). This includes `MONGODB_URI`, `JWT_SECRET`, `GEMINI_API_KEY`, and SMTP credentials.
- Use async/await throughout; avoid mixing callback-style Mongoose/Node APIs with promises.
- Both `tsconfig.json`s have `strict` mode on. Don't disable it or sprinkle `any` to make errors go away — extend the relevant interface instead (e.g. `src/types/express.d.ts` for `req.user`, or a model's `I...` interface).

## Scope notes (read before assuming something is out of scope)

The full requirements are in `USER_STORIES.md`, grouped into 13 squad-kit features covering nearly the entire original requirements brief. Three things are intentionally deferred but designed to be added later without a rebuild — don't accidentally foreclose them:

- **Channels:** only email and live chat are implemented. Don't build WhatsApp/SMS/web-form *external* channel connectors.
- **Integrations:** only this platform's own REST API is built now. Don't build ERP connectors — but keep resource IDs stable and boundaries clean so one can be added later.
- **Multi-department / multi-branch:** not built as a feature yet. Don't hardcode assumptions (e.g. a single implicit branch) that would make adding this later require a schema rewrite.

## Recommended build order

Follow the feature order in `USER_STORIES.md`'s intro: `auth` → `customer-management` → `ticket-management` + `live-chat` (parallel) → `sla-automation` → `agent-workspace` → `knowledge-base` → `ai-features` → `customer-portal` → `security-admin` → `reports-management` → `integrations` → `platform`. Later features assume earlier ones' models/endpoints exist — in particular, `knowledge-base` is built before `ai-features` because Story 34 (AI-suggested KB solutions) needs real KB content to suggest from.

## Local Arabic Q&A log (not tracked by git)

`HOW-TO-USE.md` at the repo root is a running log of Arabic-language explanations/testing-scenarios given to this user in chat — how a feature works, how to test it end-to-end, how a subsystem (SLA, live chat, etc.) behaves. It's gitignored on purpose and must never be committed, referenced in a PR, or uploaded anywhere — it's local notes for this user only.

**Whenever a chat response includes an Arabic explanation of how something works or an Arabic end-to-end testing walkthrough, append it to `HOW-TO-USE.md`** — regardless of whether the user explicitly asked to save it. Use a dated `## YYYY-MM-DD — <topic>` heading per entry, keep the content in Arabic (matching how it was actually explained), and don't rewrite/summarize past entries when adding a new one.
