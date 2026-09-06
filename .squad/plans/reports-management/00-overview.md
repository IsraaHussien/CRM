# reports-management — plan overview

Entry point for the **reports-management** feature. Stories execute in order by their `NN` prefix.

## Stories

| NN | File | Title | Tracker id | Status |
|----|------|-------|------------|--------|
| 45 | `45-story-sla-performance-report.md` | SLA performance report (Story 41) | sla-performance-report | Implemented |
| 47 | `47-story-agent-performance-report.md` | Agent performance report (Story 42) | agent-performance-report | Planned, not yet implemented — needs regeneration to add the live-chats-handled metric (see USER_STORIES.md Story 42) |
| 48 | `48-story-ticket-reports.md` | Ticket reports (Story 40) | ticket-reports | Implemented |

Superseded plan files (44, 46 — earlier drafts regenerated after scope corrections) were deleted; 45/47/48 are the current ones.

## Dependency notes

- Stories 40 and 41 share `backend/src/routes/report.routes.ts`, `backend/src/validation/report.schema.ts`, `frontend/components/reports/TimeSeriesBarChart.tsx`, and the `/admin/reports/*` shell (`layout.tsx`, `ReportsTabs.tsx`) — implemented together in one pass for exactly that reason (see each plan's own Deviations section).
- Story 40 (tickets) is scoped to tickets only — live chat is a route into ticket creation, not a second channel it tracks. Live-chat volume/handling belongs to Story 42 (agent performance) instead.
- Story 41 (SLA) intentionally spans both tickets and conversations, since SLA targets apply to both channels.
- Story 42's intake/plan need a regeneration pass before implementation to reflect the "tickets resolved vs. chats handled" split agreed during Story 40/41's planning.
