# Story intake

- Folder: `.squad/stories/reports-management/agent-performance-report/intake.md`

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):** Reports Management
- **Feature slug (folder under `plans/`):** `reports-management`

## Tracker (metadata only)

- **Tracker type:** `none`
- **Work item id:** `42` *(Story 42 in USER_STORIES.md)*
- **Work item type:** `User Story`
- **Status:** `Not started`
- **Assignee:** ``
- **Labels:** `reports-management`

---

## Title

```
Agent performance report
```

---

## Acceptance criteria

```
- Volume handled breaks out tickets resolved vs. live chats handled
  (conversations the agent actually responded to after escalation), not
  just one combined count.
- Metrics comparable across agents or over a selected period.
- Individual agents can view their own performance metrics.
- Admin can reassign work directly from this view if one agent is
  overloaded (ties to Story 10/17).
```

---

## Description

```
As a manager/admin, I want to see per-agent metrics (volume handled,
average response/resolution time, CSAT), so that I can manage the team
fairly with real data.
```

---

## Attachments

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |

None.

---

## Dependencies

- **Blocked by / related ids:** ticket-management, live-chat (volume/response-time data), Story 38/`Feedback` model (CSAT component). Story 10/17 (auto-assignment) for the "reassign from this view" tie-in.
- **Depends on code areas or other stories:** `backend/src/models/Ticket.ts`/`Conversation.ts` (`assignedAgent`, timestamps), `Feedback` model (Story 38).

## Extra notes (optional)

- "Average response/resolution time" needs timestamp deltas — e.g. first-agent-reply time minus ticket-creation time. If no dedicated "first response" timestamp is tracked on `Ticket`/`Conversation` (check current schema — likely absent), derive it from the first non-customer `Message` for that parent, via `Message.ts`'s existing `parentType`/`parentId`/`createdAt` index, rather than adding new schema fields.
- "Individual agents can view their own" — same report endpoint, but agents see only their own row (no `requireRole("admin")` restriction on read, just self-scoping for `role === "agent"` callers vs. full access for `role === "admin"`).
- "Reassign directly from this view" — reuse whatever reassignment endpoint Story 41 (agent performance) itself doesn't own; if no manual-reassignment endpoint exists yet (Story 10/17's intakes only covered AUTO-assignment, not manual reassignment), note that as a gap — this story's report can surface the data and a UI affordance, but the actual reassignment endpoint may need to be added here if nothing else built it.

## Technical hints (optional)

- Repos/roots: `.`. Primary language: `typescript`.
- `requireAuth` for all; role-based scoping inside the handler (admin sees all, agent sees self) — same ownership-plus-role pattern already established in customer-management Story 4.

## Out of scope

- Ticket volume reports (Story 39), SLA reports (Story 40), CSAT reports (Story 42) — separate stories, though this one may reuse their data.
