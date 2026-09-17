# auth — plan overview

Entry point for the **auth** feature. Stories execute in order by their `NN` prefix.

## Stories

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| 01 | `01-story-customer-sign-up.md` | Customer sign-up | customer-sign-up | — |
| 02 | `02-story-login-customer-agent-or-admin.md` | Login (customer, agent, or admin) | login-customer-agent-or-admin | — |
| 03 | `03-story-role-based-access-control.md` | Role-based access control | role-based-access-control | — |
| 49 | `49-story-64.md` | Change password | 64 | — |
| 50 | `50-story-65.md` | Forgot password (reset via email) | 65 | — |

## Dependency notes

- Story 01 exports `JwtPayload` from `backend/src/middleware/auth.ts` so both `POST /register` (this story) and `POST /login` (Story 2, not yet planned) share one JWT payload shape (`{ sub, role }`) instead of redeclaring it. Story 2's plan should import that same type rather than adding a new one.
- Story 3 (role-based access control) is already implemented in `backend/src/middleware/auth.ts` (`requireAuth`/`requireRole`) prior to any story being planned through squad-kit — Story 01 does not modify its behavior, only exports a type from the same file.
- Story 02 reuses Story 01's `bcryptjs`/JWT-signing pattern and the same `JwtPayload` shape. Both stories are only *planned* at this point (not yet executed against real source), so an executor implementing Story 02 first must either redeclare `JwtPayload` locally or coordinate with whoever implements Story 01 — see Story 02's plan, Edge Cases, "`JwtPayload` type drift".
- **Reconcile `JWT_SECRET`-missing behavior when implementing both stories:** Story 01's `/register` has no explicit `JWT_SECRET` guard — an unset secret makes `jwt.sign` throw, which Express 5 forwards to `errorHandler.ts` (`500 { error: err.message }`). Story 02's `/login` explicitly checks `process.env.JWT_SECRET` first and returns `500 { error: "Server misconfigured" }`. Both are `500`s, but with different bodies — pick one pattern and apply it to both handlers when executing, rather than shipping two different error shapes for the same failure mode.
