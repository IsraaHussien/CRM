# Story intake

- Folder: `.squad/stories/customer-portal/view-full-support-history/intake.md`

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Customer Portal
- **Feature slug (folder under `plans/`):** `customer-portal`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `37` *(Story 37 in USER_STORIES.md)*
- **Work item type:** `User Story`
- **Status:** `Not started`
- **Assignee:** ``
- **Labels:** `customer-portal`

---

## Title

```
View full support history
```

---

## Acceptance criteria

```
- Resolved/closed items remain visible and searchable in the portal.
- Customer can reopen a resolved ticket if the issue recurs.
- History includes attachments and replies exchanged.
```

---

## Description

```
As a customer, I want to view my past tickets and chats and their
outcomes, so that I have a record of previous support interactions.
```

---

## Attachments

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |

None.

---

## Dependencies

> **AMENDMENT #2 (2026-09-03) — PLANNED as `.squad/plans/customer-portal/42-story-view-full-support-history.md`.** Amendment #1 (below) planned to merge this into Story 36's intake, on the assumption Story 36 still needed frontend work. A closer read found Story 36 fully shipped already (see that intake's Amendment #2) — so there was nothing to merge INTO. This story's real remaining scope (search, ticket reopen, customer-facing chat history, and the agreed "My Support" summary strip on top of the existing `/tickets` list) is planned directly as Plan 42 above. Read that plan, not this intake, before implementing.
>
> **Amendment #1 (superseded by #2, kept for the record):** ~~this story ships together with Story 36 as one "My Support" hub, plan and implement from Story 36's intake, which now carries this story's merged scope~~ — Story 36 turned out to need no changes at all, so Plan 42 is filed under this story instead.
>
> The stale cross-references below (this file called Story 36 "Story 35", and the KB story "Story 30") predate the backlog's final numbering — read them as Story 36 and Story 31/29 respectively.

- **Blocked by / related ids:** Story 36 (track ticket status from portal) — this story extends that same customer-scoped ticket list to include closed items + search, plus adds conversation history. Story 6 (`customer-management`, view interaction history) built a similar agent-facing merge of tickets+conversations — reuse that query pattern (customer-scoped instead of admin-scoped) rather than reinventing it.
- **Depends on code areas or other stories:** `backend/src/models/Ticket.ts`, `backend/src/models/Conversation.ts`, `backend/src/models/Message.ts` (for "replies exchanged", already rendered by `TicketMessageThread` for a customer viewer).

## Extra notes (optional)

- "Reopen a resolved ticket" needs a status transition FROM `"closed"` back to an active status — this isn't in Story 11's original New→InProgress→Answered→Closed sequence; treat as a new, explicitly customer-triggerable transition (e.g. `closed → in_progress`), distinct from staff-driven transitions.
- "Searchable" — `GET /api/v1/tickets`'s customer branch already supports a subject-search regex (`q` param, no status exclusion) — reuse it, don't reinvent. The conversation-history equivalent needs its own light search/filter since `conversation.routes.ts` has none today.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- `requireAuth`, `requireRole("customer")`, scoped to `customer: req.user.id` throughout.

## Out of scope

- Live status tracking of open tickets — covered by the merged Story 36 scope, not duplicated here.
- FAQ browsing (Story 31, already shipped under `knowledge-base`).
- Feedback submission (Story 39, separate story, planned alongside this one but not merged into it).
