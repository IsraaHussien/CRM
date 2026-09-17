# Story intake

Fill this template for each story you want planned. Keep it copy-paste-friendly: the planner reads **this file and the files in `attachments/`**, nothing else.

- Folder: `.squad/stories/auth/64/intake.md`
- Binaries (screenshots, PDFs, exports): put them in `attachments/` next to this file and list them below.
- Do **not** rely on external links (tracker URLs, wiki, chat) — the planner cannot open them. Paste the content you want considered.

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Auth
- **Feature slug (folder under `plans/`):** `auth`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `64` *(used in filenames and plan tables; fill manually if empty)*
- **Work item type:** ``
- **Status:** ``
- **Assignee:** ``
- **Labels:** ``

External tracker links are **not** followed by the planner. Keep the id for naming and traceability only.

---

## Title

*(Paste the work item title verbatim. Prefilled when `squad new-story` fetched from a tracker.)*

```
Change password
```

---

## Description

*(Paste the full work item description. Prefilled when fetched from a tracker.)*

```
As a logged-in customer, agent, or admin, I want to change my own account
password from Settings, so that I can update my credentials myself without
contacting an admin.
```

---

## Acceptance criteria

*(Checklist, bullets, Gherkin, etc. Prefilled for Azure DevOps when the work item has acceptance criteria.)*

```
- Requires the current password, re-verified server-side (bcrypt compare
  against User.passwordHash), before accepting a new one — a wrong current
  password is rejected with a clear error, distinct from any "not found"
  case (caller is already authenticated, so no enumeration concern here).
- New password must satisfy the same rule already enforced at sign-up:
  minimum 8 characters (frontend/app/register/actions.ts's zod schema,
  z.string().min(8)) — reuse the same validation, don't invent a new rule.
- New password must differ from the current password (reject if identical,
  compared via bcrypt, not by re-deriving the old plaintext).
- On success: hash the new password the same way registration does
  (bcrypt, BCRYPT_SALT_ROUNDS from backend/src/routes/auth.routes.ts) and
  save it to User.passwordHash.
- On success: revoke every other active RefreshFamily for this user
  (backend/src/models/RefreshFamily.ts — set revoked = true), so every
  other logged-in session/device is forced to log in again. The session
  making this request keeps working — do not revoke the caller's own
  current family.
- On success: send a "your password was changed" notification email to
  the account's email on file via the existing email service — never
  includes the new password, and a failure to send the email must NOT
  roll back the password change (the change already happened and must
  stick; email is a best-effort notification only).
- Available identically to all three roles (customer, agent, admin) — one
  shared endpoint/UI, no per-role branching.
- Frontend: a "Change password" card/section added to the existing
  Settings page, with current/new/confirm-new-password fields as
  controlled inputs (never defaultValue/uncontrolled — see CLAUDE.md's
  "Forms backed by Server Actions" section on why), zod-validated inside
  the Server Action, with field-level errors rendered the same way
  frontend/app/login/LoginForm.tsx already does.
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

- **Blocked by / related ids:** None — builds on Story 1 (sign-up, password hashing) and Story 2 (login, session/JWT) which are already implemented. Story 65 (forgot password) is a sibling story planned right after this one and reuses this story's "revoke all sessions + send confirmation email" fallout — implement this one first.
- **Depends on code areas or other stories:**
  - `backend/src/models/User.ts` — `passwordHash` field.
  - `backend/src/models/RefreshFamily.ts` — `revoked` boolean per session family; revoking = setting this true for every family belonging to the user except the caller's current one.
  - `backend/src/middleware/auth.ts` — `requireAuth` (this endpoint needs no extra permission key; it only ever acts on the caller's own account, same convention as `backend/src/routes/me.routes.ts`'s `/availability` and `/contact` routes).
  - `backend/src/routes/me.routes.ts` — the natural home for this endpoint (self-scoped "me" actions already live here: `GET /status`, `GET /contact`, `PATCH /availability`, `PATCH/GET /email...`), not `auth.routes.ts` (which only has the unauthenticated register/login endpoints).
  - `backend/src/services/email.service.ts` — `sendEmail`/`renderEmailHtml`, already used by `me.routes.ts`'s email-confirmation flow for the template pattern to follow.
  - `backend/src/routes/auth.routes.ts` — `BCRYPT_SALT_ROUNDS` constant and the hashing/compare pattern (`bcrypt.hash`, `bcrypt.compare`) to reuse verbatim.
  - `frontend/app/settings/page.tsx`, `frontend/app/settings/SettingsForm.tsx`, `frontend/app/settings/actions.ts` — where the new "Change password" section and its Server Action go.
  - `frontend/app/login/LoginForm.tsx` — reference pattern for controlled inputs + per-field zod errors from a Server Action's state.
  - `frontend/components/ui/password-input.tsx` — existing password input primitive, reuse rather than a raw `<input type="password">`.
  - `frontend/messages/en.json` / `ar.json` — add matching keys for the new section's strings in both files in the same change (project i18n convention).

## Extra notes (optional)

- The RefreshFamily "revoke all except current" mechanic doesn't exist yet in any route — check whether the auth feature's login/logout code already exposes a way to identify "the caller's current family" (likely via a familyId claim somewhere in the access token or a cookie) before assuming a new field is needed. Read `.squad/plans/auth/02-story-login-customer-agent-or-admin.md`'s "Addendum: Refresh token mechanism" first, per CLAUDE.md's explicit instruction to read that before touching anything auth-related.
- This is purely additive to Settings — it doesn't change how login/registration work.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- Suggested endpoint: `PATCH /api/v1/me/password` (matches the existing `/me/*` self-service resource grouping), body `{ currentPassword, newPassword }`, `requireAuth` only.
- Audit log this action the same way `me.routes.ts`'s `/availability` does (`recordAuditLog`) — action name e.g. `password_changed`, no sensitive fields in metadata.

## Out of scope

- What this story explicitly does **not** cover:
  - "Forgot password" for a logged-out user who doesn't know their current password — that's Story 65, a separate intake/plan.
  - Admin-initiated reset of *another* user's password — not scoped yet, would need its own permission key if added later.
  - Rate-limiting repeated change-password attempts — not requested for this story.
