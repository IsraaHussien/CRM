# customer-portal — plan overview

Entry point for the **customer-portal** feature. Stories execute in order by their `NN` prefix.

## Stories

| NN | File | Title | Tracker id | Depends on |
|----|------|-------|------------|------------|
| 42 | [42-story-view-full-support-history.md](42-story-view-full-support-history.md) | View full support history | 37 | Story 60/29 (ticket queue — already shipped Story 36's scope), `me.routes.ts`'s `/workspace` precedent |

## Dependency notes

- **Story 36 ("Track ticket status from the portal") shipped already, folded into `ticket-management`'s Story 60 build** (`frontend/app/tickets/page.tsx`, `CustomerTicketList.tsx`, `CustomerStatusFilter.tsx`) — there is no separate plan file for it here and none should be added; its acceptance criteria are fully met by the existing code, verified when Plan 42 was written (2026-09-03).
- Story 39 (submit feedback after resolution) and Story 38 (browse FAQs — already shipped early under `knowledge-base`'s Plan 31) are separate, unrelated plans, not sequenced against Plan 42.
