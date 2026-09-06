# Story intake

- Folder: `.squad/stories/customer-portal/submit-feedback-after-resolution/intake.md`

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Customer Portal
- **Feature slug (folder under `plans/`):** `customer-portal`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `39` *(Story 39 in USER_STORIES.md)*
- **Work item type:** `User Story`
- **Status:** `Not started`
- **Assignee:** ``
- **Labels:** `customer-portal`

---

## Title

```
Submit feedback after resolution
```

---

## Acceptance criteria

```
- A feedback/rating prompt appears once an item is marked resolved.
- Feedback includes a rating scale (e.g. 1-5 / CSAT) plus an optional
  comment.
- Feedback results feed the customer-satisfaction report
  (`reports-management`).
```

---

## Description

```
As a customer, I want to rate my experience and leave feedback once a
ticket or chat is resolved, so that the company knows how well it was
handled.
```

---

## Attachments

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |

None.

---

## Dependencies

- **Blocked by / related ids:** Story 11 (ticket status → "closed") and Story 19 (conversation → "resolved") — feedback triggers off those terminal states. Story 42 (`reports-management`, CSAT report) is the eventual consumer, a much later feature — this story only needs to persist feedback, not build the report.
- **Depends on code areas or other stories:** `backend/src/models/Ticket.ts` (`status: "closed"`), `backend/src/models/Conversation.ts` (`status: "resolved"`). No existing feedback model — NEW model needed (e.g. `Feedback`: `parentType`, `parentId`, `customer`, `rating: 1-5`, `comment?`, `createdAt`).

## Extra notes (optional)

- Follow the same `parentType`/`parentId` pattern already established by `Message.ts` for referencing either a ticket or conversation, for consistency.
- **Chosen UI direction: Option C, "emailed follow-up page."** A "Rate your experience" link goes out in the resolution email (ticket → the existing close/answer email per Story 56's `email.service.ts` pattern; conversation → a new resolution email, since Story 19 close-a-live-chat may not currently send one — check and add if missing) and opens a focused, full-page rating (stars 1-5 + optional comment, no page chrome needed beyond the site header). **Also surface the same entry point in-app** — a "Rate this" action on the ticket-detail page / chat-history row once it's closed/resolved (reusing the merged Story 36/37 "My Support" hub and ticket-detail page), for a customer who never opens the email. Treat the emailed link and the in-app entry point as the same page/flow, not two builds — both just need to reach `/feedback/:parentType/:parentId` (or similar), gated so only the owning customer can submit, and idempotent (already-submitted → read-only receipt, not a re-prompt).
- One feedback entry per ticket/conversation per customer — enforce with a compound unique index (`parentType`, `parentId`, `customer`) so a second submission attempt fails cleanly rather than creating duplicates.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- `requireAuth`, `requireRole("customer")`, and verify the ticket/conversation being rated actually belongs to the requesting customer (ownership check, same pattern as other customer-scoped endpoints).

## Out of scope

- The CSAT report itself (Story 42, separate, much later feature) — this story only stores the data.
