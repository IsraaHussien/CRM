# Story intake

Fill this template for each story you want planned. Keep it copy-paste-friendly: the planner reads **this file and the files in `attachments/`**, nothing else.

- Folder: `.squad/stories/auth/65/intake.md`
- Binaries (screenshots, PDFs, exports): put them in `attachments/` next to this file and list them below.
- Do **not** rely on external links (tracker URLs, wiki, chat) — the planner cannot open them. Paste the content you want considered.

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Auth
- **Feature slug (folder under `plans/`):** `auth`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `65` *(used in filenames and plan tables; fill manually if empty)*
- **Work item type:** ``
- **Status:** ``
- **Assignee:** ``
- **Labels:** ``

External tracker links are **not** followed by the planner. Keep the id for naming and traceability only.

---

## Title

*(Paste the work item title verbatim. Prefilled when `squad new-story` fetched from a tracker.)*

```
Forgot password (reset via email)
```

---

## Description

*(Paste the full work item description. Prefilled when fetched from a tracker.)*

```
As a customer, agent, or admin who can't log in, I want to reset my password
via a link emailed to me, so that I can regain access without an admin
manually resetting it for me.
```

---

## Acceptance criteria

*(Checklist, bullets, Gherkin, etc. Prefilled for Azure DevOps when the work item has acceptance criteria.)*

```
- A public "Forgot password" page collects only the email address. The
  response is generic regardless of whether the email matches an account
  ("if an account exists for this email, we've sent a reset link") — same
  email-enumeration protection already used by Story 2's login error and
  by me.routes.ts's email-confirmation flow.
- Backend generates a single-use, time-limited reset token (expires 15
  minutes after issue) tied to the user, and stores it HASHED (e.g. SHA-256), not
  plaintext — deliberately stronger than the existing
  User.emailConfirmToken pattern (which stores plaintext), because a
  leaked password-reset token is a full account takeover, not just an
  email change.
- Requesting a new reset link for the same account invalidates any
  earlier unused/unexpired token for that account — only the most
  recently issued link can succeed.
- Emails the reset link (pointing at a frontend page, token in the query
  string) via the existing email service, following the template pattern
  me.routes.ts's email-confirmation send already uses.
- The reset page collects a new password + confirmation, validated with
  the same rule as sign-up/Story 64 (minimum 8 characters). Submitting:
  - a valid, unexpired, unused token → updates User.passwordHash (same
    bcrypt hashing as registration/Story 64) and marks the token used
    (cannot be replayed).
  - an invalid, expired, or already-used token → clear error, without
    revealing which of those three was the reason.
- On successful reset: same fallout as Story 64 — revoke every active
  RefreshFamily for the user (force logout everywhere, there's no
  "current session" to exempt here since the caller was logged out) and
  send the same "your password was changed" confirmation email.
- Frontend: two new public pages, `/forgot-password` (request form) and
  `/reset-password` (consumes the token from the URL, sets new
  password), each with real page-specific SEO metadata (per CLAUDE.md's
  SEO conventions for public pages) and i18n keys in both
  frontend/messages/en.json and ar.json.
```

---

## Attachments

Place files in `attachments/` next to this `intake.md`, then list them here so the planner knows what to open.

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |
| *(e.g. `attachments/flow.png`)* | *(e.g. UX flow)* |

*(Add rows per file. If none, write "None.")*

---

## Dependencies

- **Blocked by / related ids:** Story 64 (change password) — implemented immediately before this one in the same feature. Reuses its "hash new password the same way registration does", "revoke all RefreshFamily sessions", and "send a password-changed confirmation email" logic — factor that shared piece into something both routes call rather than duplicating it, if the plan for Story 64 already introduced a reusable function/service for it.
- **Depends on code areas or other stories:**
  - `backend/src/models/User.ts` — `passwordHash`. This story likely needs new fields or a new collection for the reset token; see `emailConfirmToken`/`emailConfirmTokenExpiresAt`/`pendingEmail` on `IUser` for the precedent of an inline-on-User token field (that one is plaintext — this story's token must be hashed instead, see acceptance criteria).
  - `backend/src/routes/me.routes.ts` — `GET /email/confirm` (lines ~524-548) is the closest existing analog: an unauthenticated, token-in-query-string, single-use, expiring-token consumption route. Follow its shape (`crypto.randomBytes(32).toString("hex")` for token generation, `CONFIRM_TOKEN_TTL_MS`-style constant for expiry) but this story's routes are NOT self-scoped "me" actions (the caller isn't authenticated at all), so they likely belong in `backend/src/routes/auth.routes.ts` alongside register/login instead, not `me.routes.ts`.
  - `backend/src/models/RefreshFamily.ts` — revoke-all-for-user on successful reset (no "current session" exemption needed here, unlike Story 64, since the caller had no active session).
  - `backend/src/services/email.service.ts` — `sendEmail`/`renderEmailHtml`, same as Story 64's confirmation email and `me.routes.ts`'s existing confirmation-email send.
  - `backend/src/routes/auth.routes.ts` — `BCRYPT_SALT_ROUNDS`, hashing pattern.
  - New frontend pages: `frontend/app/forgot-password/page.tsx` (+ its Server Action) and `frontend/app/reset-password/page.tsx` (+ its Server Action) — model the Server Action + zod + controlled-input pattern on `frontend/app/login/actions.ts` / `LoginForm.tsx`, and the public-page SEO/metadata pattern on `frontend/app/login/page.tsx` or `frontend/app/register/page.tsx`.
  - `frontend/components/ui/password-input.tsx` — reuse for the new-password field.
  - `frontend/components/SiteHeader.tsx` / login page — add a "Forgot password?" link from the login form to `/forgot-password` (otherwise the new page is unreachable, violating CLAUDE.md's "no page reachable only via ad hoc links" convention... though here it simply wouldn't be reachable at all without this link).
  - `frontend/messages/en.json` / `ar.json` — new message keys for both new pages.

## Extra notes (optional)

- This story intentionally does NOT reuse `emailConfirmToken`'s plaintext-on-User storage — use a hashed token instead (new field(s) on User, or a small new collection, whichever the plan judges simpler — a single-purpose reset flow doesn't need RefreshFamily's full family/rotation machinery, just token-hash + expiresAt + used).
- Rate-limiting repeated forgot-password requests is a known gap, intentionally deferred — flag it for `security-admin` rather than building it here.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- Suggested endpoints: `POST /api/v1/auth/forgot-password` (body: `{ email }`, always 200 with the generic message) and `POST /api/v1/auth/reset-password` (body: `{ token, newPassword }`), both unauthenticated (no `requireAuth`).
- Audit-log a successful reset the same way Story 64 does (`recordAuditLog`, action e.g. `password_reset`) — don't log failed/invalid-token attempts with any identifying detail beyond what's needed to debug abuse.

## Out of scope

- What this story explicitly does **not** cover:
  - Rate-limiting reset requests (flagged above as a `security-admin` gap).
  - Changing the account's email address (already covered by the existing `me.routes.ts` email-confirmation flow, Story 5).
  - Admin-initiated reset of another user's password.
