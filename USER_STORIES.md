# AzmSquad Customer Service Platform — User Story Backlog

## Scope (confirmed after full PDF review)

A standalone customer-service web app (Talabat-live-chat style), not attached to any product catalog.

**Personas:** Customer · Human Agent · AI Agent (Google Gemini, free tier) · Admin

**What's in, in full, matching the original requirements PDF:** customer profiles, full ticket management (categories, priority, assignment, status, escalation, history), the full agent toolkit (dashboard, tasks/reminders, quick replies, internal collaboration), full SLA & automation (targets, tracking, breach alerts), a full knowledge base (FAQs, articles, search), the full AI feature set (customer chatbot, summaries, suggested replies, auto-categorization, suggested KB solutions), a full customer portal (submit, track, history, feedback, FAQ access), full reporting (ticket/SLA/agent/CSAT reports + a management dashboard), and full security/administration (accounts & roles, permissions, audit logs, system configuration).

**Deliberately simplified for this phase (not cut — designed to extend later without a rebuild):**
- **Channels:** only email and live chat are implemented as ways customers reach support. WhatsApp/SMS/web-form as *external* channel integrations are out of scope (a customer still fills in a form to open a ticket, but that's the app's own UI, not an external channel connector).
- **Integrations:** only the platform's own public REST API is built now. ERP and other external-system connectors are a planned future enhancement — the data model keeps stable IDs and clean boundaries so they can be added later.
- **Platform:** bilingual (Arabic/English), mobile-responsive, and custom branding are in now. Multi-department and multi-branch support are a planned future enhancement — kept in mind while modeling data (e.g. not hardcoding a single implicit "branch") but not built as a full feature yet.

**Planned stack (context, not a story):** Node.js backend, MongoDB, Socket.io for real-time chat, Google Gemini API (free tier) for the AI agent, Nodemailer/SMTP for ticket-reply emails, frontend TBD.

**Frontend session handling (context, not a story):** any story building an authenticated frontend page carries the session via an `httpOnly` cookie set by the frontend's own Backend-for-Frontend proxy routes, never in `localStorage` or a client-readable cookie — see `CLAUDE.md`, "Frontend auth (session handling)".

**Confirmed flow decisions:**
- Live chat always starts with the AI agent; it escalates to a human agent when it can't help or the customer asks for a person.
- A submitted ticket is auto-acknowledged immediately, auto-assigned to an agent (same mechanism as live chat), and answered by email — no inbound-email parsing required, since the customer can also log in to see the full thread.
- Both live chats and tickets auto-assign to the first available (online) agent; SLA breaches can also trigger escalation.
- Admin manages accounts, sees every conversation, configures system settings, and can review audit logs.

**How to load these into squad-kit:** each feature below is one squad-kit "feature" folder:

```
squad new-story <feature-slug> --title "<Story Title>"
```

then paste that story's **User Story** + **Acceptance Criteria** into the generated `intake.md`.

**Recommended build order:** `auth` → `customer-management` → `ticket-management` + `live-chat` (parallel) → `sla-automation` → `agent-workspace` → `knowledge-base` → `ai-features` → `customer-portal` → `security-admin` → `reports-management` → `integrations` → `platform`. Later features assume earlier ones' models/endpoints exist — in particular, `knowledge-base` is built before `ai-features` because Story 35 (AI-suggested KB solutions) needs real KB content to suggest from. Note this order doesn't match the physical order of the `## Feature:` sections below (e.g. `agent-workspace` is listed before `sla-automation`, `ai-features` before `knowledge-base`) — the list above is the one to follow, not reading order.

---

## Feature: auth

### Story 1: Customer sign-up
**As a** visitor, **I want to** create an account with my name, email, and password, **so that** I can access customer support and have my conversations tied to my identity.
- Passwords are hashed before storage (e.g. bcrypt); duplicate emails are rejected with a clear error.
- On success, the customer is logged in automatically (session/JWT issued).
- A customer profile record is created automatically alongside the account (feeds `customer-management`).
- **Frontend:** a `/register` page with a real sign-up form (name, email, password) that calls this endpoint via the frontend's BFF proxy route, shows validation/duplicate-email errors inline, and on success lands the visitor on an authenticated page. This ships as part of this story, not a later one — see `CLAUDE.md`, "Every story... ships its frontend UI in the same story".

### Story 2: Login (customer, agent, or admin)
**As a** registered user, **I want to** log in with my email and password, **so that** I can access the features for my role.
- Invalid credentials return a generic error (doesn't reveal which field was wrong).
- A successful login returns a session/JWT encoding the user's role.
- Sessions/tokens expire after a configurable time and require re-login.
- The backend's job here ends at returning the JWT in the response body — the frontend never stores that raw token in browser-readable storage. It's carried only in an `httpOnly` cookie set by the frontend's own auth proxy routes (see `CLAUDE.md`, "Frontend auth (session handling)").
- **Frontend:** a `/login` page with a real form (email, password) that calls this endpoint via the frontend's BFF proxy route, shows a generic error on failure, and redirects to an authenticated page on success. The site's landing page links to `/login` and `/register` when signed out, and offers sign-out when signed in. Ships as part of this story per the same convention as Story 1.

### Story 3: Role-based access control
**As the** system, **I want** every API endpoint to check the caller's role, **so that** customers, agents, and admins can only do what their role allows.
- Customer-only, agent-only, and admin-only endpoints each reject callers with the wrong role.
- Unauthorized/forbidden requests return a clear 401/403 response.
- Role is read from the verified session/JWT, never trusted from client input.

---

## Feature: customer-management

> **Numbering note:** Story 55 below was added after the rest of this backlog was already numbered (see the same note under `ticket-management`) — same reason, same fix: high number, correct position. It comes first in this section since creating an account logically precedes viewing/editing one.

### Story 55: Add a customer account (as staff)
**As an** agent or admin, **I want to** create a new customer account directly, **so that** I can set someone up who contacted us by phone or in person, without requiring them to self-register first.
- Requires name, email, and an initial password (staff sets it directly — no invite-email flow for this pass); phone is optional.
- The created account has role "customer" and behaves identically to a self-registered one — that customer can log in immediately with the email/password given.
- A duplicate email is rejected the same way self-registration (Story 1) rejects one.
- **Frontend:** a real page, reachable via a "New customer" action from the staff customer roster — ships in this story, not deferred. **Backend:** a staff-only creation endpoint, same role gating as Story 4's existing customer endpoints.

### Story 4: View and edit a customer profile
**As an** agent or admin, **I want to** view and edit a customer's profile details, **so that** I have accurate information about who I'm helping.
- Profile shows name, email, phone (optional), and account creation date.
- Agent/admin can edit profile fields; the customer can edit their own basic details from their account settings.
- Every profile links out to that customer's full ticket/chat history (Story 6).

### Story 5: Maintain contact details
**As a** customer, **I want to** keep my email and phone number up to date, **so that** support can reach me and my replies go to the right place.
- Customer can update their own contact details from account settings.
- Changing the account email requires confirming the new address before it takes effect.
- Contact detail changes are reflected immediately in any new outbound emails.

### Story 6: View customer interaction history
**As an** agent, **I want to** see a single timeline of all of a customer's past tickets and chats, **so that** I have full context before responding.
- Timeline is chronological and shows channel (chat/email-ticket), subject, and status per item.
- Clicking an item opens the original ticket/conversation.
- Timeline is visible from the customer's profile and from any of their open tickets/chats.

### Story 7: Add internal notes and attachments to a customer
**As an** agent or admin, **I want to** add internal notes and attach files to a customer's profile, **so that** the team keeps shared context and supporting documents in one place.
- Notes are internal-only and never visible to the customer.
- Attachments show file name, size, uploader, and upload date.
- Notes/attachments are visible to any agent or admin who opens that customer's profile.

---

## Feature: ticket-management

> **Numbering note:** Stories 53, 54, 56, 57, 58, 60, 61, and 63 below were added after the rest of this backlog was already numbered and cross-referenced across 70+ files, so they keep their high numbers rather than triggering a full renumber. Their *position* in this section — not their number — reflects where they actually belong in the logical/dependency order: Story 53 first (it's the entry point into everything else in this feature), Story 57 right after Story 8 (the staff-side equivalent of customer submission), Story 58 right before Story 9 (categories have to exist before Story 9 can assign one), Story 54 between Story 9 and Story 10 (infrastructure the very next story needs), Story 60 right after Story 10 (an agent needs their queue before they can open anything in it), Story 56 between Story 60 and Story 11 (a reply is what normally drives a ticket into "Answered"), Story 61 directly after Story 56 (the two-way extension of the same one-way email delivery Story 56 ships), and Story 63 directly before Story 13 (its `createdBy`/`createdVia` fields are the origin fact Story 13's history view surfaces). Story 60 also depends on `platform` Story 59 (the shared pagination component), which was itself pulled forward the same way Story 50 was — see the numbering note under `platform`. **Story 61 is deferred/not started** — added to the backlog as a known gap, not queued for immediate implementation.

### Story 53: Get support — choose a ticket or live chat
**As a** logged-in customer, **I want to** land on one clear starting point that lets me choose between submitting a ticket or starting a live chat, **so that** I don't have to guess which nav link gets me help.
- A single "Get support" entry point presents both options clearly, with a one-line description of when each fits (e.g. live chat for something that needs a real-time back-and-forth, a ticket for something that doesn't).
- Choosing an option takes the customer directly into that flow — Story 8's submit-ticket form, or `live-chat` Story 14's chat widget — no extra intermediate step.
- **Frontend:** a real page (e.g. `/support`) is this story's actual deliverable, not a design note — linked from the persistent nav for any signed-in customer. Ships in this story per `CLAUDE.md`'s "every persona-facing capability ships its frontend UI in the same story," same convention as auth's Stories 1-2.

### Story 8: Submit a ticket (comment/problem)
**As a** logged-in customer, **I want to** submit a written comment or problem through a form, **so that** I can report an issue without needing to be online at the same time as an agent.
- Form captures at minimum a subject and description; attachments are optional.
- Submitting it creates a ticket with status "New," linked to the customer.
- Customer gets an in-app confirmation and an acknowledgment email with a reference number.

### Story 57: Create a ticket on behalf of a customer
**As an** agent or admin, **I want to** open a ticket on behalf of a customer, **so that** I can log an issue reported by phone, in person, or through another channel without asking them to submit it themselves.
- Form requires picking the customer plus subject, category, and description — same fields as Story 8, but the category picker is populated from Story 58, and priority is also settable up front (Story 8's version leaves priority for Story 9 to set later).
- Customer can optionally be notified by email that a ticket was opened on their behalf.
- The created ticket behaves identically to a customer-submitted one — same statuses (Story 11), same visibility to the customer (Story 36).
- **Frontend:** the same ticket form as Story 8 gains a staff mode (customer picker, priority field, "notify customer" toggle) when opened by an agent/admin, rather than a separate page. **Backend:** a staff-only creation endpoint, gated by its own permission, distinct from Story 8's customer-only endpoint.

### Story 58: Manage ticket categories and priorities
**As an** admin, **I want to** define the list of ticket categories and priority levels, **so that** Story 9's categorization has real, business-relevant options to choose from instead of nothing to pick.
- Categories and priority levels can be added, renamed, and deactivated — not hard-deleted, so history on tickets already using one stays intact.
- Deactivating one only removes it from the picker for new assignments; existing tickets keep showing it.
- This is a narrower, ticket-specific slice of Story 48's system configuration, built here first so ticket-management isn't blocked on the much-later `platform` feature.
- **Frontend:** an admin-only settings page listing and editing the category/priority lists. **Backend:** CRUD endpoints gated by a dedicated permission, separate from Story 9's per-ticket categorize/prioritize action.

### Story 9: Categorize and prioritize a ticket
**As an** agent, **I want to** assign a category and priority level to a ticket, **so that** urgent or relevant issues are handled with the right level of attention.
- Categories and priority levels are configurable by an admin (Story 58).
- Category/priority can be changed at any time and is logged.
- Filtering/sorting the ticket list by category and priority is the ticket queue's job (Story 60), not this story — this story is just the per-ticket assignment action.

### Story 54: In-app notifications for ticket events
**As an** agent, **I want to** see an in-app notification when a ticket is assigned or escalated to me, **so that** I don't have to keep refreshing my ticket list to notice new work.
- A visible notification indicator (e.g. a badge/counter in the persistent nav) appears when there's an unread ticket-assignment or ticket-escalation notification.
- Clicking a notification opens the relevant ticket directly and marks it read.
- Notifications are per-agent (an agent only sees notifications for tickets assigned/escalated to them) and persist across sessions until read.
- This is what actually implements the "assigned agent is notified in-app" bullets already written into Story 10 and Story 12 below — those stories describe the trigger, this story is the mechanism and the UI.
- **Frontend:** the notification indicator plus a way to view/open notifications ships as part of this story, not deferred. **Backend:** a notification model/endpoint backing it, triggered by Story 10 (assignment) and Story 12 (escalation).

### Story 10: Auto-assign a ticket to an available agent
**As the** system, **I want to** automatically assign a new ticket to the first available (online) agent, **so that** every ticket has an owner without manual dispatching.
- Assignment happens as soon as the ticket is created.
- The assigned agent is notified (in-app and/or email).
- Ticket ownership is visible to the assigned agent and the admin, and can be manually reassigned (Story 25).

### Story 60: View and filter the ticket queue
**As an** agent or admin, **I want to** see a filterable, sortable, paginated list of tickets, **so that** I can find what I need instead of scrolling through everything I'm not looking for.
- An agent's queue defaults to their own assigned tickets; an account granted `tickets:view_all` sees every ticket across every agent instead, with an added "Assigned to" column.
- Filterable by status, category, and priority, and sortable by any of those plus last-updated.
- Each row surfaces reply (Story 56) and escalate (Story 12) actions; reassign (`tickets:reassign`) and delete (`tickets:delete`) only appear for accounts granted that permission.
- List is paginated using `platform` Story 59's shared pagination component and query-param contract.
- **Frontend:** one ticket queue table, shared by agent and sub-admin views — they differ only in which columns/actions their permissions unlock, not in separate pages. **Backend:** `GET /api/v1/tickets` accepts `status`, `category`, `priority`, `sort`, and Story 59's pagination params, scoped server-side to the caller's role/permissions — never trusted from client-side filtering alone.

### Story 56: Reply to a ticket
**As a** human agent, **I want to** write a reply to a ticket, **so that** the customer gets an answer delivered the way they submitted their issue — by email.
- Reply is emailed to the customer's address on file and also stored on the ticket, so it's visible in-app (Story 36) and in its history (Story 13).
- Agent can attach files to a reply, same as a customer can when submitting (Story 8).
- Sending a reply moves the ticket to "Answered" (Story 11) unless the agent has already closed it.
- **Frontend:** a reply composer on the ticket detail view, available to the assigned agent (and any agent/admin with ticket access). **Backend:** a reply endpoint, gated by its own permission, that calls the email service to send — never sends email directly from the route.

### Story 61: Customer replies by email appear in the ticket thread
**As a** customer, **I want to** reply directly to the agent's email, **so that** I don't have to log into the portal or open a new ticket to continue the conversation.
- **Not started — deferred.** Story 56 ships one-way delivery only (agent → customer by email); a customer's reply currently goes nowhere. This story is what closes that gap, once picked up.
- A customer's email reply is matched to the correct open ticket (via the email's `References`/`In-Reply-To` headers) and appended to its thread as a new message, visible to the agent the same way an agent's own reply is.
- Quoted prior-thread text is stripped from the stored message — only the customer's new content is kept.
- A reply on an `answered`/`closed` ticket reopens it to `in_progress`.
- Attachments on the inbound email are saved the same way reply attachments are (Story 56).
- **Technical approach:** IMAP polling of the existing support mailbox, not a provider webhook (a webhook needs an owned domain with MX records pointed at a mail-processing provider, which this project doesn't have) — a genuinely bigger lift than a typical ticket-management story (new background-job infrastructure, header-based thread matching, quoted-text stripping), closer in size to a small feature than a single story.
- Until this ships, the ticket detail page shows a "coming soon" note near the reply composer so agents don't assume a customer's email reply will be captured.

### Story 11: Update ticket status
**As an** agent, **I want to** move a ticket through statuses (New → In Progress → Answered → Closed), **so that** everyone can see where it stands.
- Moving to "Answered" normally happens automatically when an agent sends a reply (Story 56), though an agent can also set status manually.
- Status changes are logged with who made the change and when.
- Customers see the current status when viewing their ticket (Story 36).
- Closing a ticket doesn't delete it — it remains viewable read-only.

### Story 12: Escalate a ticket
**As an** agent, **I want to** escalate a ticket to a senior agent or admin when I can't resolve it myself, **so that** stuck issues still get resolved.
- Escalation can be triggered manually by the agent, or automatically on an SLA breach (feeds from `sla-automation` Story 28).
- Escalating notifies the target person and visibly flags the ticket in lists/dashboards.
- The full ticket history travels with the escalation, so context isn't lost.

### Story 63: Track how a ticket was created
**As an** agent or admin, **I want to** see who created a ticket and, if staff created it on the customer's behalf, how they learned about the issue, **so that** I have context on a ticket's origin when reviewing or auditing it.
- **Numbering note:** added after the rest of the backlog was already numbered — same reason, same fix as the other numbering notes in this file. Positioned here (right after Story 57, right before Story 13) since Story 13's history view should be able to show a ticket's origin, and this is the story that makes that origin a real, persisted fact instead of nothing.
- Every ticket records who created it (`createdBy`) and how (`createdVia`): a customer's own self-submission (Story 8), or a staff member creating it on the customer's behalf (Story 57) — in which case the agent/admin also records the contact method that led to it (phone call, email, in person, or other), matching the "reported by phone, in person, or through another channel" language already in Story 57.
- This does **not** add any new automated intake channel (no inbound-email or phone-call ticket creation — those stay out of scope per this platform's channel scope notes). It only records, as metadata, how staff learned about an issue they're logging manually.
- Surfaced as a compact source indicator in the ticket queue table and as a "Created by / via" line in the ticket detail sidebar.
- Tickets created before this story ships have no recorded creator/channel — shown as "Unknown," never guessed or backfilled.

### Story 13: View full ticket history
**As an** agent or admin, **I want to** view the complete history/audit trail of a ticket, **so that** I can see what actions were taken, by whom, and when.
- History includes status changes, reassignments, category changes, replies, and internal notes.
- History is read-only for regular agents.
- History is exportable for record-keeping.
- Includes the ticket's origin (Story 63's `createdBy`/`createdVia`) as the first entry in the trail.

---

## Feature: live-chat

> **Numbering note:** Story 62 below was added after the rest of this backlog was already numbered — same reason, same fix as the other numbering notes in this file: high number, correct position. It sits right after Story 16 since it's the AI's other branch alongside "hand off to a human" — both are ways the AI can decide it shouldn't keep answering itself.

### Story 14: Start a live chat
**As a** logged-in customer, **I want to** open a chat widget and start a new conversation, **so that** I can get help right away.
- Starting a chat creates a conversation record linked to the customer.
- The conversation updates in real time over a WebSocket connection.
- The customer's first message triggers the AI agent to respond (Story 15).

### Story 15: AI agent responds first (Google Gemini)
**As a** customer, **I want** the AI agent to try answering as soon as I send a message, **so that** I get an instant response without waiting for a human.
- The message plus recent conversation history is sent to the Gemini API (free tier) to generate a reply.
- The reply appears in real time, clearly labeled "AI Agent."
- If the Gemini call fails or times out, the customer sees a clear fallback message.

### Story 16: Escalate to a human agent
**As a** customer, **I want to** ask for a real person (or have the AI hand off) when the AI can't help, **so that** my issue still gets resolved.
- Customer can request "talk to a human" at any point.
- Escalation flags the conversation and queues it for auto-assignment (Story 17).
- The human agent who joins sees the full prior AI conversation.

### Story 62: AI agent suggests opening a ticket
**As a** customer, **I want** the AI agent to recognize when my issue would be better handled as a ticket (needs a longer written follow-up, attachments, or is otherwise beyond what live chat/AI can resolve on the spot), **so that** I get pointed to the right path instead of going in circles in the chat.
- Based on the conversation's content/history, the AI can decide a ticket is the better path and says so directly in the chat, not just a vague non-answer.
- The suggestion includes a one-click action to open a ticket, pre-filled with a subject/description drawn from the conversation, so the customer doesn't have to retype their issue from scratch.
- The AI does **not** pick the category itself — accepting the suggestion shows the customer the same category list Story 58 manages, and the customer chooses/sets it themselves, same as the regular submit-ticket form (Story 8).
- Accepting creates the ticket the same way Story 8 does, referencing the conversation it came from; declining just continues the chat normally.
- Same Gemini timeout/fallback handling as Story 15 — a failed AI call never blocks the customer from continuing to chat normally.

### Story 17: Auto-assign an escalated chat to an available agent
**As the** system, **I want to** automatically assign an escalated chat to the first agent marked online, **so that** no chat waits for someone to notice it manually.
- Assignment happens within seconds of escalation.
- If no agent is online, the customer sees a "no agent available right now" hint with two options: keep chatting with the AI agent, or close the conversation.
- Two escalations at the same instant don't get double-assigned to the same agent.
- Chat ownership, like ticket ownership, can be manually reassigned later (Story 25).

### Story 18: Agent or admin replies to a live chat in real time
**As a** human agent (or admin), **I want to** see my assigned live chats and reply in real time, **so that** I can resolve the customer's issue directly.
- Agent sees the full conversation, including prior AI messages, before replying.
- Messages the agent sends appear instantly for the customer via WebSocket.
- Admin can also reply to any live chat, not just their own assigned ones — to take over a difficult issue, respond when no agent is available, correct an agent's handling, or handle an escalated chat.
- Agent can mark the conversation resolved (Story 19) once done.

### Story 19: Close a live chat conversation
**As a** human agent, **I want to** mark a live chat as resolved, **so that** it's clearly closed and leaves my active queue.
- Closing updates status and records a closed timestamp.
- Customer sees a "conversation closed" indicator.
- Closed conversations remain viewable read-only in history.

---

## Feature: agent-workspace

### Story 20: Unified agent dashboard
**As a** human agent, **I want** one dashboard listing both my assigned live chats and my assigned tickets, **so that** I don't have to check two separate places.
- Dashboard clearly separates/labels live chats vs. tickets.
- Items are sorted with the newest/most urgent surfaced first (e.g. an active chat or a ticket close to SLA breach).
- Agent can open any item directly from the dashboard to respond.

### Story 21: Agent availability toggle
**As a** human agent, **I want to** mark myself online/available or offline/away, **so that** the system only auto-assigns new work to me when I can respond.
- Toggle is visible and changeable at any time from the dashboard.
- Auto-assignment (chats and tickets) only considers agents currently marked online.
- The agent's status is visible to the admin.

### Story 22: Tasks and reminders
**As a** human agent, **I want to** set a task/reminder linked to a ticket or chat, **so that** I don't forget a needed follow-up.
- A reminder can be set for a specific date/time on any ticket or chat.
- The agent is notified when a reminder is due.
- Open reminders are visible in a personal to-do list on the dashboard.

### Story 23: Quick/canned replies
**As a** human agent, **I want to** insert pre-written reply templates into my responses, **so that** I can answer common questions faster and more consistently.
- Quick replies are organized by category and searchable.
- Selecting one inserts it into the reply box for editing before sending.
- Admins manage the shared library of quick replies (feeds `security-admin`).

### Story 24: Internal team collaboration
**As a** human agent, **I want to** tag colleagues and leave internal comments on a ticket or chat, **so that** we can collaborate without the customer seeing our internal discussion.
- Internal comments are clearly separated from customer-facing replies.
- Tagging a colleague sends them a notification.
- Internal comments are included in the ticket/chat's audit history.

### Story 25: Manually reassign a ticket or chat
**As an** agent or admin, **I want to** manually reassign a ticket or chat to a different agent, **so that** work can be rebalanced when an agent is overloaded, goes offline mid-item, or the wrong specialist ended up with it.
- Reassignment is available from the ticket/chat detail view and from the agent dashboard (Story 20).
- Reassignment is logged (previous assignee, new assignee, who made the change, when) and appears in the item's history (Story 13 / Story 24's audit trail).
- An admin can reassign to any agent regardless of availability status; an agent can only reassign to another agent currently marked online (Story 21).
- Both the previous and new assignee are notified.

---

## Feature: sla-automation

### Story 26: Define SLA targets
**As an** admin, **I want to** set response-time and resolution-time targets per priority level and category, **so that** service quality is measurable and consistent.
- Targets can differ by priority and/or category.
- Changes to SLA targets are logged with date and who made the change.
- Default targets apply to categories/priorities that don't have a custom target.

### Story 27: Track SLA timers on tickets and chats
**As the** system, **I want to** track elapsed time against the applicable SLA target on every open ticket/chat, **so that** agents and managers always know how much time is left.
- Each ticket/chat shows a visible countdown or elapsed-time indicator against its SLA target.
- Timers pause appropriately when waiting on the customer (e.g. ticket status "Answered," awaiting reply) if that logic is enabled.
- SLA status (on-track / at-risk / breached) is visible in list views and reports.

### Story 28: SLA breach alerts and auto-escalation
**As a** human agent, **I want to** get an alert when one of my items is close to or has breached its SLA, **so that** I can act before — or immediately after — it's too late.
- Alerts trigger at configurable thresholds (e.g. 75% of time elapsed) and again on breach.
- A breach can automatically trigger the escalation flow (Story 12 / Story 16).
- Breached items are visibly flagged in dashboards and reports (feeds `reports-management`).

---

## Feature: knowledge-base

### Story 29: Manage FAQs
**As an** admin, **I want to** create, edit, and publish FAQs, **so that** customers can find quick answers themselves.
- FAQs are organized by topic/category.
- FAQs can be draft or published; only published ones are customer-visible.
- FAQs support both English and Arabic content.

### Story 30: Write and organize help articles
**As an** admin, **I want to** write and organize longer help articles/guides, **so that** customers and agents have detailed step-by-step guidance.
- Articles support rich text, images, and step-by-step formatting.
- Articles are grouped into categories/collections and show a last-updated date.
- Articles are available in both English and Arabic.

### Story 31: Search the knowledge base
**As a** customer or agent, **I want to** search FAQs and articles by keyword, **so that** I can quickly find a relevant answer.
- Search returns ranked results across FAQs and articles.
- Search works in both Arabic and English.
- Searches with no results are logged so content gaps can be identified.

---

## Feature: ai-features

*(The customer-facing AI chatbot is Story 15, under `live-chat`. The stories below are the remaining AI Features from the PDF — all agent-facing, all powered by the Gemini integration.)*

### Story 32: Summarize a ticket or chat
**As an** agent, **I want** AI to generate a short summary of a long conversation, **so that** I can get up to speed in seconds.
- A one-click "summarize" action is available on any ticket/chat with multiple messages.
- Summary highlights the customer's issue, what's been tried, and current status.
- Agent can regenerate the summary if it's inaccurate.

### Story 33: AI-suggested replies for agents
**As an** agent, **I want** AI to draft a suggested reply based on the conversation, **so that** I can respond faster while still reviewing before sending.
- Suggestion appears as an editable draft, never sent automatically.
- Suggestion accounts for the customer's history and ticket category.
- Agent can accept, edit, or discard the suggestion.

### Story 34: Automatic categorization
**As the** system, **I want** AI to automatically suggest or apply a category/priority to a new ticket or chat, **so that** agents don't have to manually tag every one.
- New items receive an AI-suggested (or auto-applied, per admin config) category on creation.
- An agent can override the AI-assigned category at any time.
- Categorization accuracy is reviewable by an admin over time.

### Story 35: AI-suggested knowledge-base solutions
**As an** agent, **I want** AI to suggest relevant knowledge-base articles for the ticket/chat I'm working on, **so that** I can resolve it faster without searching manually.
- Suggestions are ranked by relevance to the conversation's content.
- Agent can insert a suggested article/excerpt directly into a reply.
- Suggestions improve in relevance as agents accept or dismiss them over time.

---

## Feature: customer-portal

### Story 36: Track ticket status from the portal
**As a** customer, **I want to** see the live status of tickets I've submitted, **so that** I know what's happening without asking an agent.
- Portal lists the customer's tickets with current status and last-updated time.
- Status updates reflect agent changes in real time (or on refresh).
- Customer can open a ticket to see the conversation so far.

### Story 37: View full support history
**As a** customer, **I want to** view my past tickets and chats and their outcomes, **so that** I have a record of previous support interactions.
- Resolved/closed items remain visible and searchable in the portal.
- Customer can reopen a resolved ticket if the issue recurs.
- History includes attachments and replies exchanged.

### Story 38: Browse FAQs from the portal
**As a** customer, **I want to** browse or search FAQs/articles from within the portal, **so that** I can try to solve my own issue before submitting a ticket.
- Knowledge base is accessible directly from the portal home screen.
- Portal suggests relevant articles before the customer finishes submitting a new ticket.
- FAQs display in the customer's selected language (English/Arabic).

### Story 39: Submit feedback after resolution
**As a** customer, **I want to** rate my experience and leave feedback once a ticket or chat is resolved, **so that** the company knows how well it was handled.
- A feedback/rating prompt appears once an item is marked resolved.
- Feedback includes a rating scale (e.g. 1-5 / CSAT) plus an optional comment.
- Feedback results feed the customer-satisfaction report (`reports-management`).

---

## Feature: reports-management

### Story 40: Ticket reports
**As a** manager/admin, **I want to** see reports on ticket volume, type, and trends over time, **so that** I understand the team's overall workload.
- Scoped to tickets only — live chat is a route into ticket creation (an escalated chat can become a ticket), not a second channel this report tracks; live-chat-specific volume belongs to Story 42's agent metrics instead.
- Filterable by date range (with day/week/month grouping for the trend view) and category.
- Also breaks volume down by source (how the ticket was created — customer self-service, AI suggestion, or staff via phone/email/in person/other), reusing the same source labels/colors already shown on each ticket.
- Exportable (CSV/PDF).
- Trends shown visually as well as in tables.

### Story 41: SLA performance report
**As a** manager/admin, **I want to** see how well the team meets its SLA targets, **so that** I can track whether service promises are being kept.
- Shows percentage of items meeting vs. breaching targets.
- Breakdown by agent and by category/priority.
- Breach trends trackable over time.

### Story 42: Agent performance report
**As a** manager/admin, **I want to** see per-agent metrics (volume handled, average response/resolution time, CSAT), **so that** I can manage the team fairly with real data.
- Volume handled breaks out tickets resolved vs. live chats handled (conversations the agent actually responded to after escalation), not just one combined count.
- Metrics comparable across agents or over a selected period.
- Individual agents can view their own performance metrics.
- This view links directly to reassignment (Story 25) so an admin can act immediately if one agent is overloaded.

### Story 43: Customer satisfaction (CSAT) report
**As a** manager/admin, **I want to** see aggregated customer satisfaction scores, **so that** I can measure and improve service quality.
- Aggregates feedback submitted in Story 39.
- Filterable by agent, category, and time period.
- Low scores can be drilled into to see the related ticket/chat and comment.

### Story 44: Management dashboard
**As a** manager or executive, **I want** one high-level dashboard combining ticket volume, SLA performance, agent performance, and CSAT, **so that** I can make decisions at a glance.
- Dashboard is configurable per role.
- Data refreshes automatically or on a defined schedule.
- Dashboard links out to the detailed reports above for drill-down.

---

## Feature: security-admin

### Story 45: Manage user accounts
**As an** admin, **I want to** create agent and sub-admin accounts, view every staff account, and deactivate any of them, **so that** I control who is allowed to work on the platform and at what level.
- Admin can create a new account with a role of **agent or sub-admin only** — an initial password or invite flow, no `admin` option. Full admin accounts are never created through the app; they're provisioned directly in the database (see `backend/scripts/seed-admin.ts`-style bootstrapping), so there's nothing here for even a full admin to accidentally hand out.
- Creating or deactivating an **agent or sub-admin** account requires the `users:manage` permission (admin always has it; a sub-admin only if granted one — see Story 46).
- Deactivating an existing **admin** account is a separate, narrower action: always requires a full admin, regardless of permissions — a delegated sub-admin holding `users:manage` cannot disable a higher-privileged account.
- A newly created sub-admin starts with no permissions granted (Story 46 assigns them).
- Deactivating a user immediately revokes access and excludes agents from auto-assignment.
- Account list shows every staff account (agent, admin, sub-admin) with role and current online/offline status, so an admin can see the full picture even though admin accounts aren't created here.
- **Frontend:** account management screen in the admin area — create (agent/sub-admin only)/list (all staff)/deactivate (any staff role, with the admin-target restriction above). **Backend:** endpoints gated by the `users:manage` permission, except deactivating an `admin` target, which is always full-admin-only.

### Story 46: Configure roles and permissions
**As an** admin, **I want to** grant and revoke specific permissions for the agent and sub-admin roles, **so that** sensitive actions stay limited to the right people without making every sub-admin a full admin.
- Admin is fixed and always has every permission — nothing to configure there; only agent and sub-admin rows are editable.
- Permissions are granted/revoked per role from a fixed list of named permissions covering account management, ticket/chat actions (delete, reassign), SLA and system config, KB publishing, reports, and audit access.
- Permission changes take effect immediately for affected users (checked live per request, not cached in the session).
- Agent ships with sensible working-level defaults; sub-admin starts with none granted until an admin assigns them.
- Every action currently hardcoded as admin-only elsewhere in the backlog (customer roster/creation, SLA targets, KB publishing, etc.) is covered by one of these permissions, so a sub-admin can be granted that one action instead of full admin access.
- **Frontend:** a permissions screen listing agent and sub-admin as the only editable rows, each with a checklist of permission keys; admin's row shows as fixed/all-granted. **Backend:** a `RolePermissions` collection (agent, sub-admin only) and a `requirePermission(key)` check that short-circuits true for admin, live-looks-up otherwise.

### Story 47: Review audit logs
**As an** admin, **I want to** see a log of key actions (logins, edits, deletions, reassignments), **so that** I can investigate issues and stay accountable.
- Log entries include who did what, when, and (where available) from where.
- Audit log is read-only and cannot be edited or deleted by regular users.
- Log is filterable by user, action type, and date range.

### Story 48: System configuration
**As an** admin, **I want to** configure system-wide settings (SLA defaults, quick-reply library, branding), **so that** the platform matches how the business actually operates.
- Settings are centralized in one administration area — ticket categories/priorities live here too, but as `ticket-management` Story 58, built earlier so ticket-management isn't blocked on this story.
- Changes to critical settings require admin-level permission.
- A history of configuration changes is kept for reference (feeds Story 47).

---

## Feature: integrations

### Story 49: Expose a public REST API
**As a** developer, **I want to** use a documented API to read/write tickets and customer data, **so that** the platform can be integrated with other tools now or later.
- API is authenticated (e.g. API keys or the same JWT scheme) and rate-limited.
- Supports core operations: create/read/update tickets, chats, and customers.
- API is documented (e.g. OpenAPI/Swagger) so integrators can self-serve.

> **Future enhancement (not built now, kept open):** ERP and other external-system connectors. The API and data model above are designed with stable resource IDs and clean boundaries specifically so an ERP integration can be added later without reworking the core system.

---

## Feature: platform

> **Numbering note:** Story 59 below was added after the rest of this backlog was already numbered, so it keeps its high number rather than triggering a renumber. Like Story 50, it's pulled forward and built alongside earlier feature work instead of waiting for `platform`'s turn in the build order — `ticket-management` Story 60 needs it for the ticket queue. It's placed first in this section since nothing else here depends on it.

### Story 59: Paginate list views
**As a** user of any list screen in the app, **I want to** page through results instead of everything loading at once, **so that** large lists — tickets first, others later — stay fast to load and easy to scan.
- One reusable pagination component (page controls plus a result-count readout) that any list screen can drop in, instead of each feature building its own.
- List endpoints accept page/limit query params and return that page of results plus a total count alongside them — pagination happens server-side, never by fetching everything and slicing it in the browser.
- First real integration is `ticket-management` Story 60's ticket queue; built generically enough that later list views (customer roster, KB articles, reports) can adopt the same component and query-param contract without rework.
- **Frontend:** the pagination control component, added to the shared component library. **Backend:** the page/limit query-param contract and paginated-response shape, applied first to `GET /api/v1/tickets`.

### Story 50: Bilingual Arabic & English UI
**As a** user (customer, agent, or admin), **I want to** use the interface in either Arabic or English, **so that** I can work comfortably in my preferred language.
- All core screens are available in both languages.
- Right-to-left layout is correctly supported for Arabic.
- A user can switch language from their own account settings.
- **Note:** the i18n library (next-intl) and message-key infrastructure were set up early, during `auth` (see `CLAUDE.md`, "i18n (internationalization)") — every string added by every story since then already lives in `frontend/messages/en.json` behind a translation key, not hardcoded in JSX. This story's actual work is: add `messages/ar.json` (translating every existing key), wire real locale detection/switching (including the account-settings toggle), and replace `app/layout.tsx`'s hardcoded `lang="en"`/`dir="ltr"`. It should not require touching component markup across the app.

### Story 51: Mobile-responsive design
**As a** user, **I want to** access the platform from a phone-sized screen as well as desktop, **so that** I can work from anywhere.
- Layout adapts responsively to mobile screen sizes.
- Core actions (submit/view tickets, use live chat) work fully on mobile.
- No feature is completely unavailable on mobile without a documented reason.

### Story 52: Custom branding
**As an** admin, **I want to** set our logo and brand colors for the portal, emails, and chat widget, **so that** the platform looks and feels like it belongs to our company.
- Admin can upload a logo and set brand colors from Story 48's settings area.
- Branding applies consistently across portal, emails, and chat widget.
- Branding changes take effect without requiring a redeploy.

> **Future enhancement (not built now, kept open):** multi-department and multi-branch support. Data models (tickets, agents, customers) avoid hardcoding a single implicit branch/department, so this can be layered on later without a rebuild.
