# agent-workspace — plan overview

Entry point for the **agent-workspace** feature. Stories execute in order by their `NN` prefix.

## Stories

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| _add rows as stories are planned_ |
| 19 | `19-story-agent-availability-toggle.md` | Agent availability toggle | agent-availability-toggle | — |
| 27 | `27-story-manually-reassign-a-ticket.md` | Manually reassign a ticket | manually-reassign-a-ticket | — |
| 34 | `34-story-internal-team-collaboration.md` | Internal team collaboration | internal-team-collaboration | Story 13 (ticket history), Story 54 (in-app notifications) |
| 35 | `35-story-unified-agent-dashboard.md` | Unified agent dashboard | unified-agent-dashboard | — |
| 36 | `36-story-tasks-and-reminders.md` | Tasks and reminders | tasks-and-reminders | — |
| 37 | `37-story-quick-canned-replies.md` | Quick/canned replies | quick-canned-replies | — |

## Dependency notes

- **Story 35 (unified agent dashboard) now depends on `sla-automation`, and that dependency is satisfied.** All three SLA stories are implemented: `SlaTarget` configuration (`.squad/plans/sla-automation/38-story-define-sla-targets.md`), SLA timers + the pure `computeSlaStatus()` derivation (`.../40-story-track-sla-timers-on-tickets-and-chats.md`, `backend/src/services/sla.service.ts`), and the breach monitor (`.../39-story-sla-breach-alerts-and-auto-escalation.md`, `backend/src/services/slaMonitor.service.ts`). Story 35 was re-planned around that: it ships the agreed **Triage Board** (Breached / At risk / On track columns over the agent's mixed tickets + chats), not the earlier two-section layout with a `createdAt` sorting proxy. Any story that needs an SLA status must call `computeSlaStatus()` — never re-derive the at-risk threshold.
- **Story 35 is the first frontend consumer of SLA data.** `slaStatus` / `responseTargetAt` / `resolutionTargetAt` have been on every ticket and conversation read response since sla-automation shipped, but nothing rendered them. Later stories adding SLA UI should reuse Story 35's column/indicator color contract (`--destructive` / `--warning` / `--success` only) rather than inventing per-feature status colors.
- **Stories 19 and 27 are already implemented** (agent availability toggle: `PATCH /api/v1/me/availability` + `frontend/app/actions/availability.ts`; manual reassignment: `frontend/app/tickets/ReassignAgentMenu.tsx`). They are not blockers for anything remaining in this feature. The next unimplemented story after 35 is **36 (Tasks and reminders)**.
- **Story 36 (tasks and reminders) surfaces its to-do list on Story 35's dashboard.** Once 35 lands, 36 should slot its list into `frontend/app/dashboard/page.tsx` alongside the Triage Board rather than building a self-contained section, and should reuse the existing `slaMonitor.service.ts` scheduler pattern instead of adding a second scheduler.
- **Story 34 (internal team collaboration) is implemented, tickets-only.** `POST /api/v1/tickets/:id/internal-notes` (gated by the new `tickets:post_internal_note`) writes a `Message` with `internal: true` and a persisted `taggedUserIds` list; each tagged colleague gets a `ticket_internal_note_mention` notification. The hard rule any later story must not break: **`internal: true` messages are excluded at the DB query on every customer-reachable read** — `GET /:id/messages` (which also drops the `internal` flag from the customer DTO entirely) and `buildTicketHistory()`'s `viewerRole === "customer"` branch. Internal notes on live-chat `Conversation` documents are still **not** built — `conversation.routes.ts`'s message read and `chat.socket.ts` each need their own audit before that ships.
- **`/me/*` routes are self-scoped and carry no permission key** (`backend/src/routes/me.routes.ts`, and the dashboard exception documented in `backend/src/middleware/auth.ts`'s `requireAuth` comment). Story 35's `GET /api/v1/me/workspace` follows that convention and instead calls `isActiveAccount()` explicitly, since `requireRole` alone does not re-check deactivation. Any future `/me/*` route in this feature should do the same.
