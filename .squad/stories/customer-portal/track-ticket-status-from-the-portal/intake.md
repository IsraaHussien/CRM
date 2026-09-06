# Story intake

- Folder: `.squad/stories/customer-portal/track-ticket-status-from-the-portal/intake.md`

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Customer Portal
- **Feature slug (folder under `plans/`):** `customer-portal`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `36` *(Story 36 in USER_STORIES.md)*
- **Work item type:** `User Story`
- **Status:** `Not started`
- **Assignee:** ``
- **Labels:** `customer-portal`

---

## Title

```
Track ticket status from the portal
```

---

## Acceptance criteria

```
- Portal lists the customer's tickets with current status and
  last-updated time.
- Status updates reflect agent changes in real time (or on refresh).
- Customer can open a ticket to see the conversation so far.
```

---

## Description

```
As a customer, I want to see the live status of tickets I've submitted, so
that I know what's happening without asking an agent.
```

---

## Attachments

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |

None.

---

## Dependencies

> **AMENDMENT #2 (2026-09-03) — CONFIRMED FULLY SHIPPED, closing this intake.** Amendment #1 below (also written 2026-09-03, earlier the same session) guessed the frontend was still missing based on an incomplete directory listing (checked only for subdirectories under `frontend/app/tickets/`, which hid the sibling `page.tsx` file sitting directly in that directory). A closer read found the whole story already built: `frontend/app/tickets/page.tsx` (see its own comment, lines 31-37) is the exact "Story 60 merged with Story 36" route the original status note below described — role-branched, with `CustomerTicketList.tsx` + `CustomerStatusFilter.tsx` as the customer branch. Status filter (including `closed`), pagination, last-updated, and the detail link all already work, backed by `ticket.routes.ts`'s customer branch (lines 344-351). **This story is done. Nothing here needs planning or building.** The genuinely-remaining gaps (search, reopen, chat history) belong to Story 37 and are covered by `.squad/plans/customer-portal/42-story-view-full-support-history.md` — see that plan's Prerequisites for the exact verified-against-code breakdown.
>
> **Amendment #1 (superseded by #2 above, kept for the record):** ~~the original "subsumed into Story 60, don't plan separately" status below is now half-stale: `GET /api/v1/tickets`'s customer branch was built as part of Story 60/29 — it already scopes to `customer: req.user!.id`... What's still missing, and is this story's real remaining scope, is the FRONTEND: `frontend/app/tickets/` currently only has `new/` and `[id]/` — no list page...~~
>
> **Original stale status, kept for history:** ~~subsumed into `ticket-management`'s Story 60 intake, built in the same pass as that story and `platform` Story 59~~ — this turned out to be exactly correct; amendment #1 above briefly (and wrongly) cast doubt on it.

- **Blocked by / related ids:** Story 8 (submit a ticket), Story 11 (update ticket status), Story 60 (ticket queue — already shipped the `GET /api/v1/tickets` customer branch this story consumes).
- **Depends on code areas or other stories:** `backend/src/models/Ticket.ts` (`status`, `updatedAt`), `backend/src/routes/ticket.routes.ts` (`GET /` customer branch — already implemented, read-only reuse). For the chat half (Story 37's scope): `backend/src/routes/conversation.routes.ts`'s `GET /` is currently staff-only (`requirePermission("chats:manage")`, `status: { $in: ["escalated","with_agent"] }` only) — needs a new customer branch (`customer: req.user!.id`, no status restriction so `ai_handling`/`resolved` chats show too).

## Extra notes (optional)

- Everything below this line described planned work as of Amendment #1 and is now historical only — none of it needs doing under this intake. The "Option C summary dashboard" UI direction, the reopen affordance, and the chat-history scope all moved to Plan 42 (`.squad/plans/customer-portal/42-story-view-full-support-history.md`), filed under Story 37, since that's where the actual remaining work lives.

## Technical hints (optional)

- N/A — nothing left to build here. See Plan 42 for the real technical hints (composer patterns, exact files/lines).

## Out of scope

- Everything — this story is fully shipped. Do not reopen it without first re-verifying against current code (per this repo's own lesson from Amendment #1 above: check for sibling files, not just subdirectories, before concluding something is missing).
