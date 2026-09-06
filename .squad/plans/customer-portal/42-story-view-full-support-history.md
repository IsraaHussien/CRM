# Story 42 — View full support history (Story: 37)

## Prerequisites

- Story 8 (submit a ticket), Story 56 (reply to a ticket), Story 11 (update ticket status), Story 60/29 (ticket queue + pagination) — all already shipped.
- **Story 36 ("Track ticket status from the portal") is already fully shipped** — do not re-plan or re-implement it. `frontend/app/tickets/page.tsx:31-37` (comment) confirms it was merged into Story 60's build: the customer branch of that one role-branched route renders `frontend/app/tickets/CustomerTicketList.tsx`, backed by `backend/src/routes/ticket.routes.ts`'s `GET /` customer branch (lines 344-351), which already scopes to `customer: req.user!.id`, supports `?status=` (including `closed`, via `frontend/app/tickets/CustomerStatusFilter.tsx`), sorts newest-updated-first, and paginates via `frontend/components/ListPagination.tsx`. `frontend/app/tickets/[id]/page.tsx:131` already lets the ticket's own customer view it (status badge, full message thread incl. attachments via `TicketMessageThread`).
- What's actually missing — this plan's real scope, verified by reading the current code, not assumed — is Story 37's three specific gaps:
  1. **No search** on the customer ticket list. `frontend/components/HeaderSearch.tsx:59` computes `pageSearchLabelKey` only `variant === "staff" ? PAGE_SEARCH_TARGETS[pathname] : undefined` — a customer viewer never gets the "search this page" action even though `/tickets` is already in `PAGE_SEARCH_TARGETS` (line 18) and the backend's `q` param already works for the customer branch (`ticket.routes.ts:351`, `if (searchRegex) filter.subject = searchRegex`). This is a gate, not a missing feature.
  2. **No reopen action.** `backend/src/routes/ticket.routes.ts`'s `PATCH /:id/status` (lines 874-956) already has `closed → in_progress` as a legal transition in `backend/src/services/ticketStatus.service.ts:37` (`closed: ["in_progress"]`) and `ALLOWED_MANUAL_STATUSES` (`backend/src/validation/ticket.schema.ts:110`) already includes `"in_progress"` — but the route's permission gate (`ticket.routes.ts:895-900`, `callerHasPermission(req, requiredKey)`) has no customer branch at all, so a customer caller is always 403'd. No frontend button exists either.
  3. **No conversation (chat) history for a customer at all.** `backend/src/routes/conversation.routes.ts`'s `GET /` (line 101) is gated `requirePermission("chats:manage")` at the route level — a customer never reaches the handler. `GET /:id` (line 133) already technically authorizes the owning customer (`callerAuthorizedOnConversation`, line 30: `user.id === String(conversation.customer)`) but there is no frontend page a customer can reach: `frontend/app/chats/page.tsx` and `frontend/app/chats/[id]/page.tsx` are both staff-only today (unconditional `StaffSidebar`, staff-only data fetch/rendering).
- **Chosen UI direction (agreed with the user, 2026-09-03): Option C, "summary dashboard."** Since the ticket list itself (Story 36) already exists as a working full list — not a "recent teaser" — Option C is realized as: a compact stat strip + a "recent chats" panel sit **above** the existing, unmodified `CustomerTicketList` on `/tickets` (the customer's one entry point, already linked from `SiteHeader.tsx:125`'s `myTickets` nav item and `frontend/lib/customerSearch.ts`'s `myTickets` quick-nav item — neither needs to change). Chats get their own full list + detail pair at `/chats` and `/chats/:id`, reached via the summary panel's "View all" link — mirroring the exact "one route, role-branched" pattern `frontend/app/tickets/page.tsx` already established for tickets.

---

## Story Goal

1. A customer can search their own ticket list by subject text, not just filter by status.
2. A customer viewing their own **closed** ticket sees a "Reopen ticket" action that moves it back to `in_progress` (a customer-triggered transition, distinct from staff-driven ones).
3. A customer can see a list of their own past/current live chats (any status, including `resolved`) and open one to read the full transcript, including attachments and replies — the same "history includes attachments and replies exchanged" guarantee Story 36 already gives tickets.
4. `/tickets` opens with a small stat summary (open tickets / active chats / resolved-recently counts) and a "recent chats" teaser above the existing ticket list, giving the customer one glanceable entry point instead of two disconnected surfaces.

**Not in scope:** rebuilding or restyling `CustomerTicketList`/`CustomerStatusFilter` (Story 36, already correct); real-time Socket.io updates on the new chat-history views (a resolved conversation is static; an in-progress one redirects to the live `/chat` panel instead of being re-implemented here — see Task 6); search on the chat list (low-volume per customer, deferred); feedback/rating (Story 39, separate plan); audit log (Story 47, separate plan, unrelated feature).

---

## Context — Read These Files First

1. `backend/src/routes/ticket.routes.ts` — lines 60-68 (`customerOrPermitted` helper, the exact composer pattern this plan mirrors for conversations), lines 344-351 (customer list branch, unchanged, for reference), lines 874-956 (`PATCH /:id/status` — this is where the reopen branch is added, right after the `ticket`/`404` lookup at line 889-893 and before the existing `callerHasPermission` check at line 895-900).
2. `backend/src/services/ticketStatus.service.ts` — whole file (79 lines). `ALLOWED_TRANSITIONS` (line 32-38) already permits `closed → in_progress`; `applyStatusTransition` (line 61) is reused as-is, unchanged.
3. `backend/src/validation/ticket.schema.ts` — lines 106-116 (`updateTicketStatusSchema`/`ALLOWED_MANUAL_STATUSES`); confirms `"in_progress"` is already an accepted body value, no schema change needed.
4. `backend/src/routes/conversation.routes.ts` — whole file (209 lines). Line 24-41 (`callerAuthorizedOnConversation`, already handles the customer-owns-conversation case at line 30 — no change needed there). Line 101-126 (`GET /`, the route whose middleware needs the customer branch). Line 133-179 (`GET /:id`, already customer-accessible — reused as-is by the new detail page).
5. `backend/src/routes/me.routes.ts` — lines 146-248 (`GET /workspace`, the precedent for a new self-scoped, no-permission-key, `Promise.all`-of-counts endpoint) and lines 20-37 (`GET /status`, the simplest self-scoped example) — model the new summary endpoint on this shape.
6. `backend/src/models/Conversation.ts` — whole file (60 lines). Field names: `customer`, `assignedAgent`, `status` (`ConversationStatus`), `updatedAt`/`createdAt` (timestamps).
7. `frontend/app/tickets/page.tsx` — whole file (175 lines). This is the exact "one route, role-branched" pattern (see its own comment, lines 31-36) to mirror for `/chats`; also where the new summary strip is inserted, in the `!isStaff` branch (currently lines 126-138).
8. `frontend/app/tickets/CustomerTicketList.tsx` — whole file (153 lines). Read but **do not modify its layout/columns** — only its parent (`page.tsx`) changes, to render the new summary component above it.
9. `frontend/components/HeaderSearch.tsx` — whole file (~150 lines, read at least lines 1-90 shown here). Line 15-19 (`PAGE_SEARCH_TARGETS`, `/tickets` already mapped to `searchTicketsFor`), line 59 (`pageSearchLabelKey`, the one-line gate to change).
10. `frontend/messages/en.json` — line 51 (`"searchTicketsFor"`, already exists in the `Nav` section, reused as-is), lines 1151-1196+ (`Tickets` section — read to the end of the object to see the full existing key set before adding new ones), lines 1097-1122+ (`AgentChats` section — read as the precedent for a new customer-chat-facing set of keys, but do **not** reuse this section directly, see Task 9).
11. `frontend/app/chats/page.tsx` — whole file (~90+ lines beyond what's shown here — read to the end). Staff-only today; read its data-fetch/render shape to mirror for the customer branch.
12. `frontend/app/chats/[id]/page.tsx` and `frontend/app/chats/[id]/AgentChatPanel.tsx` — read both. The page already fetches `GET /api/v1/conversations/:id` in a shape reusable for a customer branch; `AgentChatPanel` is staff-only UI (claim/reply/internal-note) and must **not** be reused for the customer branch — build a small new read-only component instead (Task 8).
13. `frontend/app/tickets/[id]/page.tsx` — lines 106-296 (already read this session). The reopen button goes in the customer (`!isStaffViewer`) branch, near the existing status badge (~line 247-251); `isLocked` (line 209) already identifies a closed ticket.
14. `frontend/app/tickets/[id]/actions.ts` — lines 78-111 (`updateTicketStatus`, already POSTs `PATCH /:id/status` with an arbitrary status — **reuse this action directly for reopen**, calling `updateTicketStatus(ticketId, "in_progress")`; no new Server Action needed).
15. `frontend/components/ListPagination.tsx` — lines 1-40+ (props shape, reused as-is for the new customer chat list).
16. `frontend/messages/ar.json` — mirror every new key added to `en.json` here in the same change, per `CLAUDE.md`'s i18n convention.

---

## Backend Tasks

### 1 — Customer ticket reopen: extend `PATCH /:id/status`

**File: `backend/src/routes/ticket.routes.ts`**

In the handler at lines 874-956, immediately after the ticket lookup (after line 893's `return;` closing the 404 branch, before line 895's existing `isCloseOrReopen` block), add a customer branch:

```typescript
if (req.user!.role === "customer") {
  if (String(ticket.customer) !== req.user!.id) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }
  if (ticket.status !== "closed" || nextStatus !== "in_progress") {
    res.status(403).json({ error: "Customers can only reopen a closed ticket" });
    return;
  }
  // Falls through to applyStatusTransition below — closed -> in_progress is
  // already a legal transition (ticketStatus.service.ts's ALLOWED_TRANSITIONS).
} else {
  const isCloseOrReopen = nextStatus === "closed" || ticket.status === "closed";
  const requiredKey: PermissionKey = isCloseOrReopen ? "tickets:close_reopen" : "tickets:change_status";
  if (!(await callerHasPermission(req, requiredKey))) {
    res.status(403).json({ error: "You do not have permission to perform this action" });
    return;
  }
}
```

Keep the rest of the handler (the `wasClosed` capture, `applyStatusTransition` call, oversight notification, response) unchanged — it already works for any caller once authorized. The route itself stays `requireAuth` only (line 876) — a customer already reaches the handler; only the in-handler gate changes. Update the route's leading comment (lines 851-873) to note the new customer branch, replacing the outdated "A customer caller is rejected here too... no separate customer branch needed" note (lines 864-868), which this task makes false.

### 2 — Customer-scoped conversation list

**File: `backend/src/routes/conversation.routes.ts`**

Add a local composer mirroring `ticket.routes.ts`'s `customerOrPermitted` (lines 60-68 there) near the top of the file, after the existing imports and before `callerAuthorizedOnConversation`:

```typescript
function customerOrPermitted(key: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user!.role === "customer") {
      next();
      return;
    }
    requirePermission(key)(req, res, next);
  };
}
```

Import `PermissionKey` from `../constants/permissions` (new import). Change line 101's middleware chain from `requireAuth, requirePermission("chats:manage")` to `requireAuth, customerOrPermitted("chats:manage")`. Inside the handler, add a customer branch before the existing `filter` ternary (lines 102-108):

```typescript
const filter =
  req.user!.role === "customer"
    ? { customer: new Types.ObjectId(req.user!.id) }
    : req.user!.role === "admin" || req.user!.role === "subadmin"
      ? { status: { $in: ["escalated", "with_agent"] } }
      : {
          status: { $in: ["escalated", "with_agent"] },
          $or: [{ assignedAgent: new Types.ObjectId(req.user!.id) }, { assignedAgent: null }],
        };
```

Note the customer branch has **no status restriction** (unlike the staff branches) — Story 37 needs `resolved`/`ai_handling` chats visible too, per its own "resolved/closed items remain visible" criterion applied to chats. The rest of the handler (populate, `withSla` mapping, response) is unchanged and already works for this filter shape. Update the route's leading comment (lines 77-100) to describe the new customer branch alongside the existing staff-scope explanation.

`GET /:id` (lines 133-179) needs **no changes** — `callerAuthorizedOnConversation` (line 30) already returns `true` for the conversation's own customer.

### 3 — Self-scoped support summary endpoint

**File: `backend/src/routes/me.routes.ts`**

Add a new route, modeled directly on `GET /workspace` (lines 146-248) but far simpler — three counts, no item lists:

```typescript
const RESOLVED_RECENTLY_WINDOW_DAYS = 30;

router.get("/support-summary", requireAuth, requireRole("customer"), async (req: Request, res: Response) => {
  const customerId = new Types.ObjectId(req.user!.id);
  const since = new Date(Date.now() - RESOLVED_RECENTLY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [openTickets, activeChats, resolvedTicketsRecently, resolvedChatsRecently] = await Promise.all([
    Ticket.countDocuments({ customer: customerId, status: { $ne: "closed" } }),
    Conversation.countDocuments({ customer: customerId, status: { $ne: "resolved" } }),
    Ticket.countDocuments({ customer: customerId, status: "closed", updatedAt: { $gte: since } }),
    Conversation.countDocuments({ customer: customerId, status: "resolved", updatedAt: { $gte: since } }),
  ]);

  res.status(200).json({
    openTickets,
    activeChats,
    resolvedRecently: resolvedTicketsRecently + resolvedChatsRecently,
  });
});
```

Place it near the other self-scoped routes (after `/status`, before `/availability`, matching the file's existing grouping). `Ticket` and `Conversation` are already imported at the top of this file (lines 6-7) — no new imports needed beyond what's already there.

---

## Frontend Tasks

### 4 — Enable "search this page" for the customer ticket list

**File: `frontend/components/HeaderSearch.tsx`**

Change line 59 from:
```typescript
const pageSearchLabelKey = variant === "staff" ? PAGE_SEARCH_TARGETS[pathname] : undefined;
```
to:
```typescript
const pageSearchLabelKey =
  variant === "staff" || pathname === "/tickets" ? PAGE_SEARCH_TARGETS[pathname] : undefined;
```
A customer viewer can only ever be on `/tickets` among `PAGE_SEARCH_TARGETS`'s three keys (`/customers` and `/admin/users` both redirect a customer away before rendering), so this is safe without a customer-specific allowlist. No other change in this file — `goToPageSearch()` (line 64-72) already works generically for any `pathname`, and the existing `searchTicketsFor` key (`en.json` line 51, already in the shared `Nav` section both variants read via `useTranslations("Nav")` at line 41) needs no new translation.

### 5 — Reopen action on the ticket-detail page

**File: `frontend/app/tickets/[id]/page.tsx`**

In the customer branch (`!isStaffViewer`, the block starting at line 247), when `isLocked` (line 209) is true, render a reopen button. Insert after the existing customer status badge block (lines 247-251):

```tsx
{!isStaffViewer && isLocked && (
  <ReopenTicketButton ticketId={ticket.id} />
)}
```

**Create file: `frontend/app/tickets/[id]/ReopenTicketButton.tsx`** — a small `"use client"` component: a `Button` that calls the existing `updateTicketStatus(ticketId, "in_progress")` Server Action (`frontend/app/tickets/[id]/actions.ts:78-111`, already imported — no new action needed), shows a pending state, and surfaces `state.error` inline on failure (same pattern as other action-backed buttons in this directory — check `TicketReplyComposer.tsx` for the exact pending/error-display convention already used here). On success, `updateTicketStatus`'s existing `revalidatePath('/tickets/${ticketId}')` (actions.ts line 109) already refreshes the page, so the button needs no manual state reset beyond React's own re-render off the revalidated Server Component props.

### 6 — Customer chat list: `/chats` role branch

**File: `frontend/app/chats/page.tsx`**

Follow `frontend/app/tickets/page.tsx`'s exact pattern (read its whole file, task 7 above): resolve `role` from `peekJwtPayload`, and when `role === "customer"`, fetch `GET /api/v1/conversations` (now customer-accessible per Task 2) and render a new `CustomerChatList` component instead of the existing staff table — mirroring how `tickets/page.tsx` branches into `CustomerTicketList` vs `StaffTicketQueue`. No pagination params needed server-side yet (the existing `GET /` route isn't paginated — same as it is for staff today, per the route's own comment at `conversation.routes.ts:95`, "Not paginated yet"); render the full returned list.

**Create file: `frontend/app/chats/CustomerChatList.tsx`** — mirrors `frontend/app/tickets/CustomerTicketList.tsx`'s structure (mobile card list + desktop table, same `Table`/`Badge`/`Button` primitives, same "eye icon to view" convention) but for conversations:
- Columns: status badge (reuse a status→label/class map like `CustomerTicketList`'s `STATUS_KEY`/`STATUS_BADGE_CLASS`, but for `ConversationStatus`: `ai_handling` → "AI handling" (muted), `escalated` → "Escalated" (destructive), `with_agent` → "With agent" (success), `resolved` → "Resolved" (muted) — same color logic `frontend/app/chats/page.tsx`'s existing `STATUS_BADGE_CLASS` already uses for the staff table, reused for the customer one too), handled-by (`assignedAgent.name` if present, else "AI Agent" when `status === "ai_handling"`, else an em dash), last-updated (`formatDateTime`, already imported elsewhere via `@/lib/utils`).
- Empty state: mirror `CustomerTicketList`'s empty-state pattern (lines 63-75 there) — no chats yet → CTA linking to `/chat` (start a live chat), matching `customerEmptyCta`'s existing pattern but for chats.
- Row action: link to `/chats/${conversation.id}`.

### 7 — Customer chat detail: `/chats/:id` role branch

**File: `frontend/app/chats/[id]/page.tsx`**

Add a customer branch alongside the existing staff-only rendering: resolve `role` from the token the same way `frontend/app/tickets/[id]/page.tsx:129` does, and when `role === "customer"`:
- Fetch `GET /api/v1/conversations/${id}` and `GET /api/v1/conversations/${id}` 's `messages` (same single call already returns both `conversation` and `messages` per `conversation.routes.ts:170-177` — no second fetch needed, unlike the ticket-detail page's separate `/messages` call).
- If the fetched conversation's `status` is **not** `"resolved"` (i.e. it's still `ai_handling`/`escalated`/`with_agent`), redirect to `/chat` instead of rendering a static view — that conversation is still live and belongs on the real-time panel, not a read-only history page (per this plan's "not in scope: real-time updates here" decision).
- Otherwise render without `StaffSidebar`, using a new read-only transcript component (Task 8).
- 403/404 handling mirrors the existing staff branch's pattern (already present in the file) — `callerAuthorizedOnConversation` on the backend already covers the "not my conversation" case with a 403.

**Create file: `frontend/app/chats/[id]/CustomerChatTranscript.tsx`** — a read-only server-rendered message list (no Socket.io, no composer, no claim/reply UI), modeled on `frontend/app/tickets/[id]/TicketMessageThread.tsx`'s rendering of sender label + text + attachments per message (that component already handles the `"customer" | "agent" | "ai" | "system"` sender-type labeling and attachment rendering this needs — read it and reuse its per-message layout/logic rather than reinventing it), but sourced from `Message`/`IMessageAttachment` shaped conversation messages instead of ticket ones. Skip any `internal: true` message defensively even though a resolved conversation's customer-facing fetch should never include one.

### 8 — "My Support" summary strip on `/tickets`

**File: `frontend/app/tickets/page.tsx`**

In the `!isStaff` branch (currently lines 126-138), fetch the new summary endpoint (Task 3) and a capped recent-chats list in parallel with the existing tickets fetch (extend the `Promise.all` at lines 89-103, or add a second `Promise.all` — either is fine, keep the existing tickets/categories fetch untouched). Render a new `CustomerSupportSummary` component above the existing `<CustomerTicketList />`, passing it the three counts and up to 3 most-recent conversations (client-side `.slice(0, 3)` of the same `GET /api/v1/conversations` response Task 6 uses — no separate "recent" backend endpoint needed).

**Create file: `frontend/app/tickets/CustomerSupportSummary.tsx`** — three stat cards (open tickets / active chats / resolved recently, using the `Card`/`stat` visual language already used elsewhere in this app's admin surfaces — check `frontend/app/dashboard/page.tsx`'s existing stat-tile markup for the pattern to match, per `CLAUDE.md`'s design-system convention of reusing established primitives) plus a compact "Recent chats" list (reuse the same status-badge map from Task 6's `CustomerChatList`, 3 rows max, each linking to `/chats/:id`) with a "View all" link to `/chats`. If the customer has zero chats and zero tickets ever, this component can render nothing beyond the stat row (all zeros) — do not special-case an empty state here beyond what naturally falls out of `0`/`0`/`0`.

### 9 — i18n

**Files: `frontend/messages/en.json` and `frontend/messages/ar.json`**

Add in lockstep (same change, both files):
- A few new keys inside the existing `"Tickets"` section (around line 1151+) for the reopen button: `reopenTicket` ("Reopen ticket" / "لا يزال هذا يحدث؟ يمكنك إعادة فتح هذه التذكرة بدلاً من إنشاء تذكرة جديدة." — write real Arabic, don't machine-gloss; follow the tone of existing Arabic strings in this section) and `reopenPending`/`reopened` for the button's pending/success states, plus `myTicketsIntro`/summary-strip labels (`openTicketsStat`, `activeChatsStat`, `resolvedRecentlyStat`, `recentChatsHeading`, `viewAllChats`) if `CustomerSupportSummary` is placed under the `Tickets` section rather than its own.
- A **new top-level section**, e.g. `"MyChats"` (do not reuse `"AgentChats"` — that section's strings are staff-voiced, e.g. "Unclaimed", "Handled by", which don't fit a customer-facing read-only view) with: `metaTitle`, `detailMetaTitle`, `heading`, `empty`, `emptyCta`, `columnStatus`, `columnUpdated`, `columnHandledBy`, `statusAiHandling`, `statusEscalated`, `statusWithAgent`, `statusResolved`, `aiAgentLabel`, `viewDetails`, `stillActiveRedirect` (a short message covering the redirect-to-`/chat` case if a direct link to an active conversation's `/chats/:id` needs a transitional message — optional, only if Task 7's redirect isn't instant/silent).

### 10 — SEO metadata

- `frontend/app/chats/page.tsx`'s existing `generateMetadata` (currently `getTranslations("AgentChats")` → `t("metaTitle")`) needs a role-aware title now that a customer can land here too. Simplest correct fix per `CLAUDE.md`'s SEO convention (a real title per page, `robots: { index: false, follow: false }` since it's authenticated either way): read the role from the cookie inside `generateMetadata` itself (it can call `cookies()`/`peekJwtPayload` the same way the page component does) and pick `MyChats.metaTitle` vs `AgentChats.metaTitle` accordingly. Same for `frontend/app/chats/[id]/page.tsx`'s `generateMetadata`.

---

## Edge Cases & Failure Modes

- **Reopen race: ticket answered/closed again between page load and click.** `applyStatusTransition` (`ticketStatus.service.ts:67-69`) already no-ops on `nextStatus === ticket.status` and throws `InvalidStatusTransitionError` for any other illegal transition from whatever the *current* status actually is at write time — the route's existing `catch` (ticket.routes.ts:911-916) already turns that into a 400. No new handling needed; the customer branch added in Task 1 reads `ticket.status` fresh from the same `findById` call already in the handler, not a stale value.
- **Customer attempts to reopen a ticket that isn't theirs, or one that isn't closed.** Both covered explicitly by the two `if` checks in Task 1's snippet — ownership first (403, generic message, no existence leak), then the closed-only guard (403, specific message). Add a test for both (Test Plan #2, #3).
- **Customer navigates directly to `/chats/:id` for an active (non-resolved) conversation.** Task 7's redirect to `/chat` handles this — but `/chat` (`frontend/app/chat/page.tsx`) always starts/continues *the* customer's current live chat; verify (read `frontend/app/chat/page.tsx` and `LiveChatPanel.tsx`'s conversation-resolution logic before finalizing Task 7) that it resumes the *same* conversation rather than always creating a new one, or the redirect would silently orphan the customer's in-progress chat. If `LiveChatPanel` has no notion of "resume conversation `:id`", note this as a known limitation in the PR description rather than silently shipping a broken redirect — do not invent a "resume" mechanism in `LiveChatPanel` as part of this plan; that's out of scope.
- **Zero tickets and zero chats ever (brand-new customer).** `GET /support-summary` returns `{0,0,0}` cleanly (all three `countDocuments` calls resolve to 0, no error). `CustomerSupportSummary` renders the stat row as all zeros per Task 8's note; `CustomerTicketList` already has its own empty state (lines 63-75, already built); `CustomerChatList` needs the equivalent (Task 6).
- **`q` search with no matches.** Already handled identically to the existing staff case — `ticket.routes.ts`'s customer branch (line 351) just narrows `filter.subject`; an empty result set renders `CustomerTicketList`'s existing `currentQuery`-aware empty message (line 65-66, `t("empty")`, distinct from the "no tickets ever" CTA state) — no new frontend handling needed, this already works today for the (currently unreachable) `q` param.
- **A resolved conversation with zero messages** (e.g. abandoned immediately) — `CustomerChatTranscript` should render its own empty-thread state rather than crash on an empty array; mirror `TicketMessageThread`'s handling of an empty `messages` prop if it has one, or add a simple "No messages" fallback.

---

## Test Plan

1. **`backend/tests/routes/ticket.routes.test.ts`** (or the sibling file already covering `PATCH /:id/status` — locate via `grep -rn "PATCH.*status" backend/tests/`): add cases for the new customer branch — (a) customer reopens their own closed ticket → 200, status becomes `in_progress`; (b) customer attempts to reopen a ticket belonging to a different customer → 403; (c) customer attempts to change status on a non-closed ticket (e.g. `new → in_progress`) → 403 (customers get no other transition); (d) customer attempts to set `status: "closed"` themselves → 403 (only `in_progress` is allowed via this branch, per Task 1's second check being an exact `nextStatus !== "in_progress"` guard, not a broader allow-list).
2. **`backend/tests/routes/conversation.routes.test.ts`** (or wherever `GET /` is currently tested — locate via `grep -rn "GET.*conversations" backend/tests/`): add cases — customer sees only their own conversations regardless of status (including `resolved` and `ai_handling`, unlike the staff filter); a customer with zero conversations gets `{ conversations: [] }`, not a 403.
3. **`backend/tests/routes/me.routes.test.ts`** (create if no such file exists; check first): `GET /support-summary` — counts are correct for a fixture customer with a mix of open/closed tickets and active/resolved conversations spanning inside/outside the 30-day window; a non-customer role gets 403 (`requireRole("customer")`).
4. **Frontend:** no test runner exists yet in `frontend/` (per `CLAUDE.md`, "No test runner exists in `frontend/` yet") — no new frontend automated tests; verify manually per the Verification Steps below.

---

## Verification Steps

1. **Backend builds:** `npm run typecheck && npm run build` in `backend/`.
2. **Backend tests:** `npm test` in `backend/` — all existing tests plus the new ones from the Test Plan pass.
3. **Frontend builds:** `npm run build` in `frontend/`.
4. **Manual — reopen:** log in as a customer with a closed ticket (or close one via an agent account first), open `/tickets/:id`, confirm the "Reopen ticket" button appears only when closed, click it, confirm the ticket becomes `in_progress` and the button disappears/replaces with the normal closed-ticket-free view.
5. **Manual — search:** as a customer, on `/tickets`, use the header search box, type a substring of an existing ticket's subject, confirm the "search this page" suggestion appears and navigating it filters the list via `?q=`.
6. **Manual — chats:** as a customer with at least one resolved and one active conversation, visit `/chats`, confirm both appear with correct status badges; open the resolved one and confirm the read-only transcript renders (including any attachment); open the active one and confirm it redirects to `/chat`.
7. **Manual — summary:** visit `/tickets` as a customer, confirm the stat strip's three numbers match reality (cross-check against the raw ticket/chat counts) and the recent-chats teaser links correctly to `/chats` and to individual chats.
8. **Manual — RTL/Arabic:** switch locale to Arabic (`UserMenu`), repeat steps 4-7, confirm no untranslated keys/English fallback strings appear.
9. **Regression:** confirm the staff branches of `/tickets`, `/tickets/:id`, `/chats`, `/chats/:id` are visually and functionally unchanged (log in as an agent/admin and spot-check each).

---

## Done Criteria

- [x] Customer can search their own ticket list by subject via the header "search this page" action. (`HeaderSearch.tsx`'s one-line gate change; not manually clicked through in a browser — see note below.)
- [x] Customer can reopen their own closed ticket from the ticket-detail page; the transition is rejected for any other caller/state. Covered by 4 new backend tests (reopen success, wrong-owner 403, non-reopen-transition 403, close-attempt 403), all passing.
- [x] Customer can list all their own conversations (any status) at `/chats` and open a resolved one to read its full transcript. Attachments deliberately not rendered in the transcript — conversation messages carry no attachment concept today (live chat has no upload path), documented in `CustomerChatTranscript.tsx`'s header comment rather than built speculatively.
- [x] `/tickets` opens with a stat summary (open tickets / active chats / resolved recently) and a recent-chats teaser above the existing ticket list.
- [x] All new/changed backend routes use the correct auth shape (`customerOrPermitted` for the shared conversation list, `requireRole("customer")` for the self-scoped summary, ownership checks for reopen) — no bare permission bypass.
- [x] `en.json`/`ar.json` updated together, no missing-translation-key errors on either locale (both validated as parseable JSON; frontend build — which resolves every `t()` key at least once via prerendering — passed clean).
- [x] Both `/chats` pages carry real, role-aware SEO metadata (`robots: noindex` either way).
- [x] `npm run typecheck`, `npm run build` (backend), `npm run build` (frontend), and `npm test` (backend) all pass — verified this session (675 backend tests passing, 1 pre-existing skip; both builds clean).

**Not done this session:** the Verification Steps' manual browser walkthroughs (steps 4-9 — reopen click-through, search suggestion, chat list/transcript, summary numbers, Arabic/RTL, staff-regression spot-check) were not performed; only automated typecheck/build/test. Flag to the user before considering this story fully closed.
