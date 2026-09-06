# Story intake

- Folder: `.squad/stories/reports-management/ticket-reports/intake.md`

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Reports Management
- **Feature slug (folder under `plans/`):** `reports-management`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `40` *(Story 40 in USER_STORIES.md)*
- **Work item type:** `User Story`
- **Status:** `Not started`
- **Assignee:** ``
- **Labels:** `reports-management`

---

## Title

```
Ticket reports
```

---

## Description

```
As a manager/admin, I want to see reports on ticket volume, type, and
trends over time, so that I understand the team's overall workload.
```

---

## Acceptance criteria

```
- Scoped to tickets only — live chat is a route into ticket creation (an
  escalated chat can become a ticket), not a second channel this report
  tracks; live-chat-specific volume belongs to Story 42's agent metrics
  instead.
- Filterable by date range (with day/week/month grouping for the trend
  view) and category.
- Also breaks volume down **by source** — `Ticket.createdVia`
  (`customer_portal | ai | phone | email | in_person | other`, set by
  ticket-management Story 63) — reusing the existing labels/colors
  `StaffTicketQueue.tsx` already defines for this field
  (`SOURCE_LABEL_KEY`, `SOURCE_BADGE_CLASS`: customer_portal→primary,
  ai→`--channel-ai`, phone→`--channel-phone`, email→`--channel-email`,
  in_person→`--channel-in-person`, other→`--channel-other`), not a new
  palette.
- Exportable (CSV/PDF).
- Trends shown visually as well as in tables.
```

---

## Attachments

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |

None.

---

## Dependencies

- **Blocked by / related ids:** ticket-management (Stories 8-13) and live-chat (Stories 14-19) for the underlying data.
- **Depends on code areas or other stories:** `backend/src/models/Ticket.ts` — aggregation queries (Mongoose `aggregate()`) grouped by `createdAt` (date range), `category`, and `createdVia` (source). ticket-management Story 63 (`createdBy`/`createdVia` fields) and `frontend/app/tickets/StaffTicketQueue.tsx` (existing source label/emoji/color mapping to reuse verbatim).

## Extra notes (optional)

- "Exportable (CSV/PDF)" — no export mechanism exists anywhere in this codebase yet (same gap flagged in ticket-management Story 13's intake). CSV is straightforward (stream/format rows, no new dependency strictly required). PDF generation typically needs a new dependency (e.g. a PDF-generation library) — note this as a new dependency decision rather than silently picking one; CSV alone may be an acceptable first pass if PDF is judged out of proportion, but state that explicitly rather than silently dropping half the acceptance criteria.
- "Trends shown visually" is a FRONTEND charting concern — no charting library exists in `frontend/package.json` yet; this is a new frontend dependency decision (e.g. a lightweight charting library) — note explicitly rather than assuming one is already available.
- This is the first of 5 reports-management stories (39-43); if a shared aggregation/query-building pattern makes sense across them (e.g. common date-range/filter parsing), establish it here since this is the first.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- `requireAuth`, `requireRole("admin")` (manager role isn't in the current `UserRole` enum — treat "manager" as `"admin"` unless a broader role model exists by the time this is planned).

## Out of scope

- SLA/agent/CSAT-specific reports (Stories 40-42, separate stories in this same feature).
- The unified management dashboard (Story 43, separate, immediately-following story).
