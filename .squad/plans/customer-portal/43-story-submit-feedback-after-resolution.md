# Story 43 — Submit feedback after resolution (Story: 39)

## Prerequisites

- Story 11 (ticket status → `closed`), Story 19 (conversation → `resolved`, including the customer-triggerable close path). Both already shipped.
- Plan 42 (`customer-portal/42-story-view-full-support-history.md`, this session) added the ticket-reopen and customer chat-history surfaces this plan's entry points sit next to — read it first for the exact shape of `ReopenTicketButton.tsx` and `CustomerChatTranscript`'s host page, since Task 8 below adds a sibling action next to each.
- **Verified gap, not assumed:** neither the ticket-close path (`backend/src/routes/ticket.routes.ts`'s `PATCH /:id/status`, lines 874-956+) nor the conversation-resolve path (`backend/src/sockets/chat.socket.ts`'s `conversation:close` handler, lines 488-520) sends any email today — the only existing ticket email is the reply notification (`POST /:id/messages`, line ~1264-1279), unconditional on the resulting status. The chosen UI direction (**Option C, "emailed follow-up page"**) therefore needs two NEW email triggers, not a reuse of an existing one — the original intake note assuming Story 56's reply email covered "close" was wrong; corrected here.
- No existing `Feedback` model or `/api/v1/feedback` router — confirmed via `grep -rn "Feedback" backend/src` (no hits) and `backend/src/app.ts`'s full router-mount list (lines 5-37).

---

## Story Goal

1. Once a ticket is closed or a conversation is resolved, the owning customer receives an email with a "Rate your experience" link.
2. The same rating opportunity is also reachable in-app — a "Rate this" action next to the reopen button on a closed ticket, and next to a resolved chat's transcript — for a customer who never opens the email.
3. The link/action leads to one page: a 1-5 star rating plus an optional comment. Submitting it is a one-time action — revisiting shows a read-only receipt, never a second form.
4. Visiting the page for an item that isn't actually closed/resolved yet (a stale or guessed link) shows a clear "not resolved yet" state, not an error.

**Not in scope:** the CSAT report itself (Story 42, separate, much later `reports-management` feature — this story only persists the data); retrofitting a resolution email onto every historical closed ticket/resolved conversation (only transitions happening from this point forward trigger one).

---

## Context — Read These Files First

1. `backend/src/models/Message.ts` — lines 1-34 (the `parentType`/`parentId` pattern this plan's `Feedback` model copies, per `CLAUDE.md`'s data-model convention already noted there: "`parentType` + `parentId` let one model serve both, per CLAUDE.md's data model notes").
2. `backend/src/routes/ticket.routes.ts` — lines 874-956 (`PATCH /:id/status`, already modified once this session for Story 37's reopen branch — re-read the CURRENT state of this handler, not the version described in Plan 42, before editing again). The new email send goes in the mirror-image position of the existing `if (wasClosed && ticket.status !== "closed")` reopen-notification block (around line 926-935): a `newly closed` check.
3. `backend/src/sockets/chat.socket.ts` — lines 485-520 (`conversation:close` handler). The email send goes after `await conversation.save()` (line 514), before the `io.to(...).emit("conversation:closed", ...)` broadcast (lines 516-519) or after — either is fine since the email is fire-and-forget and must never block/fail the socket response.
4. `backend/src/services/email.service.ts` — whole file (81 lines). `sendEmail({ to, subject, text, html, attachments? })` and `renderEmailHtml({ heading, bodyHtml, ctaText, ctaUrl })` are reused as-is, no changes to this file.
5. `backend/src/app.ts` — whole file (49 lines). Line 37's comment block is where the new `app.use("/api/v1/feedback", feedbackRoutes);` is added, following the exact `import ... from "./routes/X.routes"` + `app.use("/api/v1/X", xRoutes)` pattern every other router already uses.
6. `backend/src/routes/ticket.routes.ts` — lines 710-767 (`GET /:id (Story 9)`), specifically the "returns 404 (not 403) for a customer who doesn't own the ticket" test convention referenced at line 717 of `backend/tests/routes/ticket.routes.test.ts` — this plan's feedback routes follow the same "404, not 403, for someone else's item" rule to avoid an existence-leak.
7. `backend/src/models/Ticket.ts` — lines 85-95ish (`customer`, `status`, `ticketNumber` fields — confirm exact field names before writing the model/routes).
8. `backend/src/models/Conversation.ts` — whole file (60 lines, already read this session) — `customer`, `status` fields.
9. `frontend/app/tickets/[id]/ReopenTicketButton.tsx` (this session's Plan 42) — the exact `useTransition` + inline-message pattern to mirror for the new feedback form's submit button.
10. `frontend/app/tickets/[id]/page.tsx` — the customer branch where `ReopenTicketButton` was just wired in (Plan 42) — the new "Rate this" entry point goes in the same region, visible even without `isLocked` being reopenable (i.e. it can coexist with the reopen button, not replace it).
11. `frontend/app/chats/[id]/page.tsx` and `CustomerChatTranscript.tsx` (this session's Plan 42) — the customer branch that renders only for a `resolved` conversation — the "Rate this chat" entry point goes here.
12. `frontend/lib/auth.ts`, `frontend/lib/session.ts` — the standard cookie/silent-refresh pattern every other authenticated Server Component page in this app uses (see `frontend/app/tickets/[id]/page.tsx`'s top for the reference shape) — the new feedback page follows it exactly, since an email-clicked link may arrive with an expired access cookie.
13. `backend/tests/sockets/chat.socket.test.ts` — lines 792-871 (`conversation:close` describe block) — the existing test harness/mocking pattern (`vi.mock("../../src/services/liveChatAi.service", ...)` at line 16) to extend with an `emailService` spy for the new resolve-email test.
14. `backend/tests/routes/ticket.routes.test.ts` — the `PATCH /api/v1/tickets/:id/status` describe block (already extended once this session for Plan 42's reopen tests) — add the new close-email test alongside those.
15. `frontend/messages/en.json` / `ar.json` — add a new top-level `"Feedback"` section; mirror the two-file lockstep convention used throughout this session's edits.

---

## Backend Tasks

### 1 — `Feedback` model

**Create file: `backend/src/models/Feedback.ts`**

```typescript
import mongoose, { Document, Schema, Types } from "mongoose";

export type FeedbackParentType = "ticket" | "conversation";

/**
 * A customer's post-resolution rating (customer-portal Story 39). One row
 * per (parentType, parentId, customer) — the compound unique index below is
 * what makes a second submission attempt fail cleanly instead of creating a
 * duplicate, per this story's own acceptance criterion.
 */
export interface IFeedback extends Document {
  parentType: FeedbackParentType;
  parentId: Types.ObjectId;
  customer: Types.ObjectId;
  rating: number;
  comment?: string;
  createdAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    parentType: { type: String, enum: ["ticket", "conversation"], required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

feedbackSchema.index({ parentType: 1, parentId: 1, customer: 1 }, { unique: true });

export const Feedback = mongoose.model<IFeedback>("Feedback", feedbackSchema);
```

### 2 — Validation schema

**Create file: `backend/src/validation/feedback.schema.ts`**

```typescript
import { z } from "zod";

export const feedbackParentTypeParamSchema = z.object({
  parentType: z.enum(["ticket", "conversation"], { error: "parentType must be \"ticket\" or \"conversation\"" }),
  parentId: z.string(),
});

export const feedbackBodySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
```

(Confirm this project's exact zod version's `{ error: ... }` custom-message syntax against a sibling schema file — e.g. `backend/src/validation/ticket.schema.ts`'s `updateTicketStatusSchema` at line 113 already uses this shape — match it exactly rather than an older `.min(1, "message")` positional form.)

### 3 — Feedback routes

**Create file: `backend/src/routes/feedback.routes.ts`**

```typescript
import express, { Request, Response } from "express";
import { Types } from "mongoose";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParams } from "../middleware/validate";
import { Feedback } from "../models/Feedback";
import { Ticket } from "../models/Ticket";
import { Conversation } from "../models/Conversation";
import { feedbackParentTypeParamSchema, feedbackBodySchema } from "../validation/feedback.schema";

const router = express.Router();

async function loadEligibleParent(
  parentType: "ticket" | "conversation",
  parentId: string,
  customerId: string
): Promise<{ found: boolean; owned: boolean; eligible: boolean }> {
  if (!Types.ObjectId.isValid(parentId)) return { found: false, owned: false, eligible: false };
  if (parentType === "ticket") {
    const ticket = await Ticket.findById(parentId).select("customer status");
    if (!ticket) return { found: false, owned: false, eligible: false };
    return {
      found: true,
      owned: String(ticket.customer) === customerId,
      eligible: ticket.status === "closed",
    };
  }
  const conversation = await Conversation.findById(parentId).select("customer status");
  if (!conversation) return { found: false, owned: false, eligible: false };
  return {
    found: true,
    owned: String(conversation.customer) === customerId,
    eligible: conversation.status === "resolved",
  };
}

router.get(
  "/:parentType/:parentId",
  requireAuth,
  requireRole("customer"),
  validateParams(feedbackParentTypeParamSchema),
  async (req: Request<{ parentType: "ticket" | "conversation"; parentId: string }>, res: Response) => {
    const { parentType, parentId } = req.params;
    const check = await loadEligibleParent(parentType, parentId, req.user!.id);
    // Same "404, not 403" rule as GET /tickets/:id for a non-owned item —
    // no existence leak either way.
    if (!check.found || !check.owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const existing = await Feedback.findOne({ parentType, parentId, customer: req.user!.id }).select(
      "rating comment createdAt"
    );
    res.status(200).json({
      eligible: check.eligible,
      feedback: existing ? { rating: existing.rating, comment: existing.comment ?? null, createdAt: existing.createdAt } : null,
    });
  }
);

router.post(
  "/:parentType/:parentId",
  requireAuth,
  requireRole("customer"),
  validateParams(feedbackParentTypeParamSchema),
  validateBody(feedbackBodySchema),
  async (req: Request<{ parentType: "ticket" | "conversation"; parentId: string }>, res: Response) => {
    const { parentType, parentId } = req.params;
    const check = await loadEligibleParent(parentType, parentId, req.user!.id);
    if (!check.found || !check.owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!check.eligible) {
      res.status(403).json({ error: "This isn't resolved yet" });
      return;
    }
    try {
      const feedback = await Feedback.create({
        parentType,
        parentId,
        customer: req.user!.id,
        rating: req.body.rating,
        comment: req.body.comment,
      });
      res.status(201).json({ rating: feedback.rating, comment: feedback.comment ?? null, createdAt: feedback.createdAt });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "You've already submitted feedback for this" });
        return;
      }
      throw err;
    }
  }
);

export default router;
```

Confirm `validateParams`'s exact export/signature from `backend/src/middleware/validate.ts` before using it (grep the file — every other route already imports it, e.g. `ticket.routes.ts`'s `validateParams(userIdParamsSchema)` usage referenced at `customer.routes.ts:253` this session).

### 4 — Mount the router

**File: `backend/src/app.ts`**

Add `import feedbackRoutes from "./routes/feedback.routes";` alongside the other route imports (after line 16), and `app.use("/api/v1/feedback", feedbackRoutes);` alongside the other mounts (after line 37, replacing the now-partially-stale TODO comment at lines 38-40 to drop `reports-management`'s CSAT-report mention if it still lists this as pending — leave the rest of that TODO intact for the features genuinely still unmounted).

### 5 — Ticket-closed resolution email

**File: `backend/src/routes/ticket.routes.ts`**

In `PATCH /:id/status`'s handler, after the existing reopen-oversight block (lines 926-935 as read this session):

```typescript
if (!wasClosed && ticket.status === "closed") {
  try {
    const customer = await User.findById(ticket.customer).select("name email");
    if (customer) {
      const feedbackUrl = `${CLIENT_ORIGIN}/feedback/ticket/${ticket.id}`;
      await sendEmail({
        to: customer.email,
        subject: `Your ticket is resolved — #${ticket.id}`,
        text: `Hi ${customer.name},\n\nYour ticket "${ticket.subject}" has been closed. We'd love to know how we did: ${feedbackUrl}`,
        html: renderEmailHtml({
          heading: "Your ticket is resolved",
          bodyHtml: `Hi ${customer.name},<br><br>Your ticket "${ticket.subject}" has been closed. We'd love to know how we did.`,
          ctaText: "Rate your experience",
          ctaUrl: feedbackUrl,
        }),
      });
    }
  } catch (err) {
    // Best-effort, same reasoning as the reply email above — the status
    // change itself must never fail or roll back on an SMTP hiccup.
    console.error("[tickets] resolution email failed", err);
  }
}
```

`User`, `sendEmail`, `renderEmailHtml`, `CLIENT_ORIGIN` are all already imported/declared in this file (confirmed: `User` is used elsewhere in this handler for `targetAgent` lookups; `sendEmail`/`renderEmailHtml` at line 9; `CLIENT_ORIGIN` at line 36) — no new imports needed.

### 6 — Conversation-resolved email

**File: `backend/src/sockets/chat.socket.ts`**

After `await conversation.save();` (line 514) in the `conversation:close` handler, before or after the broadcast (either order is fine — this is fire-and-forget):

```typescript
try {
  const customer = await User.findById(conversation.customer).select("name email");
  if (customer) {
    const feedbackUrl = `${CLIENT_ORIGIN}/feedback/conversation/${conversation.id}`;
    await sendEmail({
      to: customer.email,
      subject: "Your chat is resolved",
      text: `Hi ${customer.name},\n\nYour live chat has been resolved. We'd love to know how we did: ${feedbackUrl}`,
      html: renderEmailHtml({
        heading: "Your chat is resolved",
        bodyHtml: `Hi ${customer.name},<br><br>Your live chat has been resolved. We'd love to know how we did.`,
        ctaText: "Rate your experience",
        ctaUrl: feedbackUrl,
      }),
    });
  }
} catch (err) {
  console.error("[chat.socket] resolution email failed", err);
}
```

Check this file's existing imports before adding: it may not currently import `User`, `sendEmail`/`renderEmailHtml`, or a `CLIENT_ORIGIN` constant (grep for each at the top of `chat.socket.ts` first) — add whichever are missing, matching `ticket.routes.ts`'s exact import lines (`import { sendEmail, renderEmailHtml } from "../services/email.service";`, `const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";`, `import { User } from "../models/User";`).

---

## Frontend Tasks

### 7 — Feedback page

**Create file: `frontend/app/feedback/[parentType]/[id]/page.tsx`**

Server Component, auth pattern copied from `frontend/app/tickets/[id]/page.tsx`'s top (cookie → access-token presence → silent-refresh redirect → role check, `role !== "customer"` redirects to `/dashboard`). Validate `parentType` is `"ticket"` or `"conversation"` from the route param (404 via `notFound()` otherwise, mirroring `frontend/app/chats/[id]/page.tsx`'s use of `notFound`). Fetch `GET /api/v1/feedback/${parentType}/${id}`:
- 404 → `notFound()`.
- `!eligible` → render a small "not resolved yet" state with a link back to `/tickets` or `/chats` (whichever `parentType` implies).
- `feedback` present → render a read-only receipt (filled stars matching `feedback.rating`, the comment if any, the date).
- Otherwise → render `<FeedbackForm parentType={parentType} parentId={id} />`.

**Create file: `frontend/app/feedback/[parentType]/[id]/FeedbackForm.tsx`** — `"use client"`. A 5-star clickable picker (`useState<number>` for the selected rating, 0 = none picked yet), an optional `Textarea` for the comment, a submit button using the same `useTransition` + Server Action pattern as `ReopenTicketButton.tsx`. Disable submit until a rating is picked (1-5). On success, either `router.refresh()` (re-fetches the Server Component, which will now render the read-only receipt) or hold local success state — prefer `router.refresh()` for consistency with how `updateTicketStatus`'s `revalidatePath` already drives the analogous reopen flow.

**Create file: `frontend/app/feedback/actions.ts`** — `"use server"`. `submitFeedback(parentType: "ticket" | "conversation", parentId: string, input: { rating: number; comment?: string })`, same `getBearerToken`/401-retry-once shape as every other Server Action this session touched (`frontend/app/tickets/[id]/actions.ts`'s pattern). POSTs to `${API_URL}/api/v1/feedback/${parentType}/${parentId}`. Maps a 409 response to a clear "you've already rated this" error string, a 403 to "not resolved yet", anything else to a generic failure message — same per-status-code branching convention as `escalateTicket` in `frontend/app/tickets/[id]/actions.ts`.

### 8 — Entry points on the existing detail pages

**File: `frontend/app/tickets/[id]/page.tsx`** — next to the `ReopenTicketButton` rendered this session for Plan 42 (`{!isStaffViewer && isLocked && <ReopenTicketButton ... />}`), add a "Rate this ticket" link to `/feedback/ticket/${ticket.id}`, shown under the same `!isStaffViewer && isLocked` condition (both can coexist — reopening and rating are independent actions on a closed ticket).

**File: `frontend/app/chats/[id]/page.tsx`** — in the customer branch added this session for Plan 42 (the `role === "customer"` block that renders `CustomerChatTranscript` only when `data.conversation.status === "resolved"`), add a "Rate this chat" link to `/feedback/conversation/${id}`.

### 9 — i18n

**Files: `frontend/messages/en.json` and `frontend/messages/ar.json`**

New top-level `"Feedback"` section: `metaTitle`, `heading`, `ratingLabel`, `commentLabel`, `commentPlaceholder`, `submit`, `submitPending`, `alreadySubmitted`, `thanksHeading`, `thanksBody`, `notEligibleHeading`, `notEligibleBody`, `backToTickets`, `backToChats`, `notFound`, `errorGeneric`, `errorAlreadySubmitted`, `errorNotEligible`. Plus two small additions to existing sections: `"TicketDetail"` gets `rateThisTicket`; `"MyChats"` gets `rateThisChat`.

### 10 — SEO metadata

`frontend/app/feedback/[parentType]/[id]/page.tsx` exports `generateMetadata` — `getTranslations("Feedback")`, `title: t("metaTitle")`, `robots: { index: false, follow: false }` (authenticated page, per `CLAUDE.md`'s convention already followed by every other page touched this session).

---

## Edge Cases & Failure Modes

- **Customer visits a stale/guessed feedback link for a ticket that isn't closed yet.** `loadEligibleParent`'s `eligible: false` (Task 3) is surfaced by the GET route as `{ eligible: false, feedback: null }`, and the page (Task 7) renders the "not resolved yet" state rather than a form or an error — the item existing and being theirs is still confirmed (404 covers "not found or not theirs" first).
- **Double submission (double-click, or the emailed link opened twice in two tabs).** The compound unique index (Task 1) makes the second `Feedback.create` throw `E11000`, caught explicitly in Task 3's POST handler and turned into a 409 with a clear message — no duplicate row, no 500.
- **SMTP failure on either resolution email.** Both Task 5 and Task 6 wrap the send in `try/catch` with a `console.error` and nothing else — the status transition (ticket closing / conversation resolving) must succeed regardless, same as every other best-effort email in this codebase (`ticket.routes.ts`'s existing reply-email `catch`).
- **A ticket that was closed BEFORE this story shipped, then later reopened and re-closed.** The email fires on this new closing (the `!wasClosed && ticket.status === "closed"` check only cares about the transition happening now) — no backfill attempted for historical closures, per the Story Goal's explicit "not in scope."
- **Rating submitted without ever picking a star (0).** Client-side: `FeedbackForm`'s submit button stays disabled until `rating >= 1` (Task 7). Server-side: `feedbackBodySchema`'s `.min(1)` rejects a `0` or missing rating with 400 regardless, so a client bypassing the disabled button (dev tools, direct API call) still can't submit an invalid rating.
- **A staff account (agent/admin/subadmin) somehow reaches `/feedback/...` or calls the API directly.** `requireRole("customer")` on both routes (Task 3) rejects with 403 before any parent lookup — feedback is customer-only by design, mirroring every other customer-scoped route this session touched.

---

## Test Plan

1. **`backend/tests/routes/feedback.routes.test.ts`** (new file, mirror the `beforeAll`/`afterAll`/`beforeEach` MongoMemoryServer setup already used in `backend/tests/routes/ticket.routes.test.ts`): 401 without a token on both routes; 403 for a non-customer; GET returns `eligible: false, feedback: null` for an open ticket/active conversation; GET returns 404 for someone else's ticket; POST succeeds (201) for a closed ticket owned by the caller and persists the row; POST on the same item again returns 409; POST on a not-yet-closed ticket returns 403; POST with `rating: 0` and `rating: 6` both return 400; POST with a 1001-character comment returns 400.
2. **`backend/tests/routes/ticket.routes.test.ts`** — extend the `PATCH /:id/status` describe block (already extended this session for Plan 42): add a test that closing a previously-open ticket calls `sendEmail` (spy on `../../src/services/email.service`) with the customer's email and a URL containing `/feedback/ticket/`; add a test that closing an ALREADY-closed ticket (a same-state PATCH, if reachable — check `applyStatusTransition`'s early-return behavior first) does NOT re-send the email.
3. **`backend/tests/sockets/chat.socket.test.ts`** — extend the `conversation:close` describe block (lines 792-871): add a test that resolving a previously-active conversation calls `sendEmail` with a URL containing `/feedback/conversation/`; add a test that closing an already-resolved conversation (the existing "does not re-broadcast" test at line 871) also does NOT re-send the email — reuse that test's setup, add the spy assertion.
4. **Frontend:** no test runner in `frontend/` yet (per `CLAUDE.md`) — verify manually per Verification Steps below.

---

## Verification Steps

1. **Backend builds:** `npm run typecheck && npm run build` in `backend/`.
2. **Backend tests:** `npm test` in `backend/` — all existing tests plus the new ones pass.
3. **Frontend builds:** `npm run build` in `frontend/`.
4. **Manual — ticket flow:** as staff, close a ticket belonging to a test customer account; confirm a "Rate your experience" email is logged (dry-run mode, per `email.service.ts`'s `SMTP_HOST` fallback) or delivered; as that customer, click "Rate this ticket" on the ticket-detail page instead, submit a rating + comment, confirm a read-only receipt appears on revisit, and that clicking the link a second time doesn't offer the form again.
5. **Manual — chat flow:** resolve a live chat (as customer, agent, or admin — all three can trigger it per Story 19), confirm the equivalent email fires and the in-app "Rate this chat" entry point on the resolved chat's detail page works the same way.
6. **Manual — not-yet-eligible:** visit `/feedback/ticket/:id` for a still-open ticket directly, confirm the "not resolved yet" state renders, not an error or a form.
7. **Manual — RTL/Arabic:** repeat steps 4-6 with the locale switched to Arabic, confirm no untranslated strings.
8. **Regression:** confirm staff-side ticket closing and chat resolving are otherwise unchanged in behavior/latency (the email send should not visibly block either action from the closing staff member's perspective).

---

## Done Criteria

- [x] Closing a ticket sends the owning customer a "Rate your experience" email with a working link. Covered by a backend test asserting `sendEmail` is called with a URL containing `/feedback/ticket/`, plus a same-state no-resend test.
- [x] Resolving a conversation sends the equivalent email. Covered by two `chat.socket.test.ts` tests (new resolution, and already-resolved no-resend).
- [x] Both a closed ticket and a resolved conversation have an in-app "Rate this" entry point for a customer who doesn't use the email.
- [x] The feedback page shows a working 1-5 star + optional-comment form for an eligible, not-yet-rated item; a read-only receipt for an already-rated item; and a clear "not resolved yet" state for an ineligible one.
- [x] A second submission attempt for the same item is rejected (409), never creates a duplicate row. Covered by a backend test.
- [x] `en.json`/`ar.json` updated together.
- [x] `npm run typecheck`, `npm run build` (backend), `npm run build` (frontend), and `npm test` (backend) all pass — verified this session (696 backend tests passing, 1 pre-existing skip; both builds clean).

**Not done this session:** same caveat as Plan 42 — the manual browser walkthroughs (Verification Steps 4-7: full ticket/chat email+rating flow, not-yet-eligible state, Arabic/RTL) were not performed; only automated typecheck/build/test.
