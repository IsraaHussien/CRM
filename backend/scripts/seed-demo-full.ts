// Full realistic demo-data seed — implements SEED_DEMO_DATA_PROMPT.md at the
// repo root. Wipes every collection this app owns and repopulates it with a
// believable cast of accounts, ~10 ticket lifecycle scenarios (each with a
// real statusHistory/categoryHistory/priorityHistory/assignedAgentHistory
// trail and a real Message thread), several long AI+agent live chats, and
// FAQs/help articles in every knowledge-base category — enough real, long
// history to exercise AI ticket/chat summarization (summary.service.ts)
// against more than a two-message thread.
//
// Deliberately deterministic (a fixed, named cast) rather than randomized —
// see SEED_DEMO_DATA_PROMPT.md's "Implementation notes" for why. Guarded
// against NODE_ENV=production so this destructive wipe can never run against
// a real deployment's MONGODB_URI.
//
// After seeding, exports every collection to backend/seed-data/*.json so the
// generated dataset can be committed to the repo — anyone who clones it can
// load the exact same data instantly via `npm run seed:import-demo-data`
// (backend/scripts/import-demo-data.ts) without re-running this script or
// needing any external API key, since nothing here calls Gemini.
import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import bcrypt from "bcryptjs";
import { User, IUser, UserRole, Language } from "../src/models/User";
import { Ticket, TicketPriority, TicketStatus, TicketCreationChannel } from "../src/models/Ticket";
import { Conversation, ConversationStatus } from "../src/models/Conversation";
import { Message, MessageSenderType } from "../src/models/Message";
import { Faq } from "../src/models/Faq";
import { HelpArticle } from "../src/models/HelpArticle";
import { TicketCategory } from "../src/models/TicketCategory";
import { SlaTarget } from "../src/models/SlaTarget";
import { SlaSystemSettings } from "../src/models/SlaSystemSettings";
import { Notification } from "../src/models/Notification";
import { RefreshFamily } from "../src/models/RefreshFamily";
import { KB_CATEGORY_SLUGS, KbCategorySlug } from "../src/constants/kb";
import { PermissionKey } from "../src/constants/permissions";

const BCRYPT_SALT_ROUNDS = 10;
const SEED_DATA_DIR = path.join(__dirname, "..", "seed-data");

const NOW = new Date();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);

// Every account this script creates gets printed at the end with its plain-
// text password (never logged anywhere else) so a human exploring the
// seeded data can actually sign in as any of them.
const CREDENTIALS: { role: string; name: string; email: string; password: string }[] = [];

async function mkUser(data: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  preferredLanguage?: Language;
  isOnline?: boolean;
  isActive?: boolean;
  permissions?: PermissionKey[];
  internalNotes?: string[];
}): Promise<IUser> {
  const passwordHash = await bcrypt.hash(data.password, BCRYPT_SALT_ROUNDS);
  const user = await User.create({
    name: data.name,
    email: data.email,
    passwordHash,
    role: data.role,
    preferredLanguage: data.preferredLanguage ?? "en",
    isOnline: data.isOnline ?? false,
    isActive: data.isActive ?? true,
    permissions: data.permissions ?? [],
    internalNotes: (data.internalNotes ?? []).map((text) => ({ text })),
  });
  CREDENTIALS.push({ role: data.role, name: data.name, email: data.email, password: data.password });
  return user;
}

async function setTimestamps(model: typeof Ticket | typeof Conversation | typeof Message, id: Types.ObjectId, when: Date) {
  await model.updateOne({ _id: id }, { $set: { createdAt: when, updatedAt: when } });
}

async function addMessage(
  parentType: "ticket" | "conversation",
  parentId: Types.ObjectId,
  senderType: MessageSenderType,
  senderId: Types.ObjectId | null,
  text: string,
  when: Date,
  extra: {
    internal?: boolean;
    aiKbSuggestion?: { type: "faq" | "article"; id: string; title: { en: string; ar: string }; slug?: string } | null;
    aiTicketSuggestion?: { subject: string; description: string } | null;
  } = {}
) {
  const msg = await Message.create({
    parentType,
    parentId,
    senderType,
    senderId,
    text,
    internal: extra.internal ?? false,
    aiKbSuggestion: extra.aiKbSuggestion ?? null,
    aiTicketSuggestion: extra.aiTicketSuggestion ?? null,
  });
  await setTimestamps(Message, msg._id, when);
  return msg;
}

// ---------------------------------------------------------------------------
// Reference data: ticket categories, SLA targets/settings
// ---------------------------------------------------------------------------

const CATEGORY_DEFS = [
  { name: "Billing", active: true },
  { name: "Technical Issue", active: true },
  { name: "Account Access", active: true },
  { name: "Feature Request", active: true },
  { name: "General Inquiry", active: true },
  { name: "Shipping & Delivery", active: false }, // deactivated but still referenced by an old ticket below
  { name: "Refunds", active: true },
];

async function seedCategories() {
  const docs = await TicketCategory.insertMany(CATEGORY_DEFS);
  const byName = new Map(docs.map((d) => [d.name, d]));
  return byName;
}

async function seedSla(adminId: Types.ObjectId) {
  await SlaTarget.insertMany([
    { priority: null, category: null, responseMinutes: 60, resolutionMinutes: 480 }, // mandatory default
    { priority: "urgent", category: null, responseMinutes: 15, resolutionMinutes: 120 },
    { priority: "high", category: null, responseMinutes: 30, resolutionMinutes: 240 },
    { priority: "low", category: null, responseMinutes: 120, resolutionMinutes: 1440 },
    { priority: null, category: "Billing", responseMinutes: 45, resolutionMinutes: 360 },
  ]);
  await SlaSystemSettings.create({ _id: "default", atRiskPercent: 75, scanIntervalMinutes: 1, updatedBy: adminId });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const AGENT_FULL_PERMISSIONS: PermissionKey[] = [
  "tickets:reassign",
  "reports:view",
  "ai:override_category",
  "tickets:create_for_customer",
  "tickets:categorize",
  "tickets:change_priority",
  "tickets:reply",
  "tickets:post_internal_note",
  "tickets:change_status",
  "tickets:close_reopen",
  "tickets:escalate",
  "chats:manage",
  "customers:manage",
  "ai:summarize",
];

async function seedAccounts() {
  // Standing accounts the /login "Fill demo credentials" / "Fill admin
  // credentials" buttons (frontend/app/login/LoginForm.tsx) point at — kept
  // identical to seed-admin.ts / seed-demo-customer.ts so those buttons keep
  // working after a full re-seed.
  const admin1 = await mkUser({ name: "Admin One", email: "admin@azmsquad.com", password: "Admin@12345", role: "admin" });
  const admin2 = await mkUser({ name: "Admin Two", email: "admin2@azmsquad.com", password: "Admin@12345", role: "admin" });
  const demoCustomer = await mkUser({
    name: "Demo Customer",
    email: "demo@azmsquad.com",
    password: "Demo@12345",
    role: "customer",
  });

  const subadmin = await mkUser({
    name: "Dina Kamal",
    email: "dina.kamal@azmsquad.com",
    password: "Subadmin@12345",
    role: "subadmin",
    isOnline: true,
    permissions: [
      "staff:view_list",
      "staff:view_account",
      "sla:targets_view",
      "sla:targets_edit",
      "kb:faq_view_list",
      "kb:faq_create",
      "kb:faq_edit",
      "kb:article_view_list",
      "kb:article_create",
      "kb:article_edit",
      "reports:view",
      "reports:export",
      "tickets:categories_view",
      "tickets:categories_edit",
      "tickets:export_history",
      "audit:view",
    ],
  });

  const agentDefs: { name: string; email: string; isOnline: boolean; permissions: PermissionKey[] }[] = [
    { name: "Omar Nasser", email: "omar.nasser@azmsquad.com", isOnline: true, permissions: AGENT_FULL_PERMISSIONS },
    {
      name: "Layla Haddad",
      email: "layla.haddad@azmsquad.com",
      isOnline: true,
      permissions: AGENT_FULL_PERMISSIONS.filter((p) => p !== "tickets:escalate"),
    },
    { name: "Youssef Amin", email: "youssef.amin@azmsquad.com", isOnline: false, permissions: AGENT_FULL_PERMISSIONS },
    {
      name: "Mona Saleh",
      email: "mona.saleh@azmsquad.com",
      isOnline: true,
      permissions: ["tickets:reply", "tickets:change_status", "tickets:close_reopen", "ai:summarize"],
    },
    {
      name: "Karim Adel",
      email: "karim.adel@azmsquad.com",
      isOnline: false,
      permissions: AGENT_FULL_PERMISSIONS.filter((p) => p !== "chats:manage"),
    },
    { name: "Nour Fathy", email: "nour.fathy@azmsquad.com", isOnline: true, permissions: AGENT_FULL_PERMISSIONS },
    {
      name: "Hassan Ali",
      email: "hassan.ali@azmsquad.com",
      isOnline: false,
      permissions: ["tickets:reply", "tickets:change_status"],
    },
    {
      name: "Rania Fouad",
      email: "rania.fouad@azmsquad.com",
      isOnline: true,
      permissions: AGENT_FULL_PERMISSIONS.filter((p) => p !== "tickets:reassign" && p !== "customers:manage"),
    },
  ];
  const agents: IUser[] = [];
  for (const def of agentDefs) {
    agents.push(
      await mkUser({
        name: def.name,
        email: def.email,
        password: "Agent@12345",
        role: "agent",
        isOnline: def.isOnline,
        permissions: def.permissions,
      })
    );
  }

  const customerDefs: { name: string; email: string; lang: Language; active: boolean; notes?: string[] }[] = [
    { name: "Sara Ibrahim", email: "sara.ibrahim@example.com", lang: "en", active: true },
    { name: "Ahmed Mostafa", email: "ahmed.mostafa@example.com", lang: "ar", active: true },
    { name: "Nadia El-Sayed", email: "nadia.elsayed@example.com", lang: "ar", active: true },
    {
      name: "John Carter",
      email: "john.carter@example.com",
      lang: "en",
      active: true,
      notes: ["VIP account — enterprise plan, prefers phone follow-up over email."],
    },
    { name: "Fatima Zahra", email: "fatima.zahra@example.com", lang: "ar", active: true },
    { name: "Michael Chen", email: "michael.chen@example.com", lang: "en", active: true },
    { name: "Yara Khalil", email: "yara.khalil@example.com", lang: "ar", active: true },
    { name: "David Brown", email: "david.brown@example.com", lang: "en", active: true },
    {
      name: "Salma Reda",
      email: "salma.reda@example.com",
      lang: "ar",
      active: true,
      notes: ["Has asked twice about a bulk/team discount — flag to sales if it ever exists."],
    },
    { name: "Chris Anderson", email: "chris.anderson@example.com", lang: "en", active: false },
    { name: "Huda Mansour", email: "huda.mansour@example.com", lang: "ar", active: true },
    { name: "Peter Wilson", email: "peter.wilson@example.com", lang: "en", active: true },
    { name: "Rania Tawfik", email: "rania.tawfik@example.com", lang: "ar", active: false },
    {
      name: "Laura Smith",
      email: "laura.smith@example.com",
      lang: "en",
      active: true,
      notes: ["Reported a billing discrepancy in the past that turned out to be a currency-display bug, not a real overcharge."],
    },
    { name: "Khaled Fahmy", email: "khaled.fahmy@example.com", lang: "ar", active: true },
    { name: "Emma Davis", email: "emma.davis@example.com", lang: "en", active: true },
    { name: "Mostafa Zaki", email: "mostafa.zaki@example.com", lang: "ar", active: true },
    { name: "Grace Lee", email: "grace.lee@example.com", lang: "en", active: true },
  ];
  const customers: IUser[] = [];
  for (const def of customerDefs) {
    customers.push(
      await mkUser({
        name: def.name,
        email: def.email,
        password: "Cust@12345",
        role: "customer",
        preferredLanguage: def.lang,
        isActive: def.active,
        internalNotes: def.notes,
      })
    );
  }

  return { admin1, admin2, subadmin, agents, customers, demoCustomer };
}

// ---------------------------------------------------------------------------
// Tickets — ~10 coherent lifecycle scenarios
// ---------------------------------------------------------------------------

async function seedTickets(ctx: {
  categories: Map<string, InstanceType<typeof TicketCategory>>;
  admin1: IUser;
  admin2: IUser;
  agents: IUser[];
  customers: IUser[];
  chatConversationId: Types.ObjectId;
}) {
  const { categories, admin1, admin2, agents, customers, chatConversationId } = ctx;
  const cat = (name: string) => categories.get(name)!._id as Types.ObjectId;
  const catName = (name: string) => name;

  // --- Scenario 1: straightforward low-priority ticket, closed same day ---
  {
    const customer = customers[0]; // Sara
    const agent = agents[0]; // Omar
    const created = daysAgo(30);
    const ticket = await Ticket.create({
      subject: "How do I update my billing address?",
      description: "I moved recently and my invoices still show my old address. Can you update it?",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("General Inquiry"),
      priority: "low",
      status: "closed",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 20 * MIN) },
        { status: "answered", changedBy: agent._id, changedAt: at(created, 2 * HOUR) },
        { status: "closed", changedBy: agent._id, changedAt: at(created, 5 * HOUR) },
      ],
      sla: { responseTargetAt: at(created, 2 * HOUR), resolutionTargetAt: at(created, 24 * HOUR), breached: false, atRiskAlerted: false },
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Thanks for reaching out! I can update that for you — could you confirm the new address?",
      at(created, 20 * MIN)
    );
    await addMessage("ticket", ticket._id, "customer", customer._id, "Sure, it's 14 Nile Corniche, Cairo, Egypt.", at(created, 40 * MIN));
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "All set — your billing address is updated and will show on your next invoice.",
      at(created, 2 * HOUR)
    );
    await addMessage("ticket", ticket._id, "customer", customer._id, "Perfect, thank you!", at(created, 2 * HOUR + 5 * MIN));
  }

  // --- Scenario 2: urgent ticket that breaches its SLA before anyone replies, auto-escalates ---
  {
    const customer = customers[3]; // John
    const created = daysAgo(22);
    const ticket = await Ticket.create({
      subject: "Cannot log in — production outage on our end",
      description: "Our whole team is locked out since this morning. This is blocking work — please treat as urgent.",
      customer: customer._id,
      assignedAgent: null,
      category: catName("Technical Issue"),
      priority: "urgent",
      status: "escalated",
      escalatedTo: admin2._id,
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "escalated", changedBy: admin1._id, changedAt: at(created, 16 * MIN) },
      ],
      slaHistory: [
        { event: "at_risk", at: at(created, 11 * MIN) },
        { event: "breached", at: at(created, 16 * MIN) },
      ],
      sla: { responseTargetAt: at(created, 15 * MIN), resolutionTargetAt: at(created, 2 * HOUR), breached: true, atRiskAlerted: true },
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "customer",
      customer._id,
      "Any update? This is blocking our whole team.",
      at(created, 10 * MIN)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      admin2._id,
      "Apologies for the delay — I'm on this now and looking into your account directly.",
      at(created, 20 * MIN)
    );
  }

  // --- Scenario 3: reassigned twice before resolution ---
  {
    const customer = customers[7]; // David
    const created = daysAgo(18);
    const first = agents[2]; // Youssef
    const second = agents[4]; // Karim
    const third = agents[0]; // Omar
    const ticket = await Ticket.create({
      subject: "Wrong item keeps showing on my invoice",
      description: "My last two invoices list a service I never signed up for.",
      customer: customer._id,
      assignedAgent: third._id,
      category: catName("Billing"),
      priority: "medium",
      status: "answered",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: first._id, changedAt: at(created, 30 * MIN) },
        { status: "answered", changedBy: third._id, changedAt: at(created, 2 * DAY) },
      ],
      assignedAgentHistory: [
        { assignedAgent: first._id, changedBy: first._id, changedAt: created },
        { assignedAgent: second._id, changedBy: first._id, changedAt: at(created, HOUR) },
        { assignedAgent: third._id, changedBy: second._id, changedAt: at(created, DAY) },
      ],
      sla: { responseTargetAt: at(created, 45 * MIN), resolutionTargetAt: at(created, 6 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 34 * MIN) },
        { event: "breached", at: at(created, 46 * MIN) },
      ],
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      first._id,
      "Taking a look — this looks like it might be a billing-team issue, routing it over to make sure it's fixed correctly.",
      at(created, 30 * MIN)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "system",
      null,
      "This ticket was reassigned from Youssef Amin to Karim Adel.",
      at(created, HOUR)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "system",
      null,
      "This ticket was reassigned from Karim Adel to Omar Nasser.",
      at(created, DAY)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      third._id,
      "Sorry for the back-and-forth — I can confirm that line item was billed in error and has been removed. A corrected invoice is on its way.",
      at(created, 2 * DAY)
    );
  }

  // --- Scenario 4: category and priority both change mid-life ---
  {
    const customer = customers[10]; // Huda
    const agent = agents[1]; // Layla
    const created = daysAgo(12);
    const ticket = await Ticket.create({
      subject: "Charged twice this month",
      description: "I see two charges for the same subscription this billing cycle.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Technical Issue"),
      priority: "high",
      status: "in_progress",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 25 * MIN) },
      ],
      categoryHistory: [{ category: "Billing", changedBy: agent._id, changedAt: at(created, 40 * MIN) }],
      priorityHistory: [{ priority: "medium", changedBy: agent._id, changedAt: created }],
      // Left in progress rather than escalated/closed, so `breached` must
      // already be true here (not left for the live SLA monitor to flip on
      // its first scan) — its resolutionTargetAt is necessarily in the past
      // for any backdated-by-days scenario, and the monitor auto-escalates
      // (forces status: "escalated") the FIRST time it sees an open ticket
      // with `sla.breached: false` past its target. Every scenario below
      // that intentionally stays new/in_progress/answered follows the same
      // rule; only a genuinely on-track ticket (see Scenario 1) can leave
      // this false. See SEED_DEMO_DATA_PROMPT.md's implementation notes.
      sla: { responseTargetAt: at(created, 30 * MIN), resolutionTargetAt: at(created, 4 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 22 * MIN) },
        { event: "breached", at: at(created, 31 * MIN) },
      ],
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Looking into it now — double-charges usually mean a duplicate payment attempt went through, moving this to Billing to check the ledger.",
      at(created, 25 * MIN)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Confirmed a duplicate charge on our end — since it involves a live payment, I've bumped the priority so it gets refunded faster.",
      at(created, 40 * MIN)
    );
  }

  // --- Scenario 5: at-risk, then manually escalated ---
  {
    const customer = customers[13]; // Laura
    const agent = agents[6]; // Hassan
    const created = daysAgo(9);
    const ticket = await Ticket.create({
      subject: "Account locked after failed password reset",
      description: "I tried resetting my password three times and now I can't log in at all.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Account Access"),
      priority: "high",
      status: "escalated",
      escalatedTo: agents[0]._id, // Omar
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 10 * MIN) },
        { status: "escalated", changedBy: agent._id, changedAt: at(created, 35 * MIN) },
      ],
      slaHistory: [{ event: "at_risk", at: at(created, 22 * MIN) }],
      sla: { responseTargetAt: at(created, 30 * MIN), resolutionTargetAt: at(created, 4 * HOUR), breached: false, atRiskAlerted: true },
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "I can see the lock on your account — this needs an access-level unlock I can't perform myself, escalating to a senior agent now.",
      at(created, 35 * MIN)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agents[0]._id,
      "Unlocked your account and sent a fresh reset link to your email — let us know once you're back in.",
      at(created, 50 * MIN)
    );
  }

  // --- Scenario 6: created via AI (accepted the live-chat AI's "open a ticket" suggestion) ---
  {
    const customer = customers[5]; // Michael
    const agent = agents[5]; // Nour
    const created = daysAgo(7);
    const ticket = await Ticket.create({
      subject: "Export feature keeps timing out",
      description: "Every time I try to export my report as CSV it spins forever and then fails.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Technical Issue"),
      priority: "medium",
      status: "answered",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 15 * MIN) },
        { status: "answered", changedBy: agent._id, changedAt: at(created, HOUR) },
      ],
      // Stays "answered" — must already be breached, see Scenario 4's comment.
      sla: { responseTargetAt: at(created, 30 * MIN), resolutionTargetAt: at(created, 4 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 22 * MIN) },
        { event: "breached", at: at(created, 31 * MIN) },
      ],
      sourceConversation: chatConversationId,
      createdBy: customer._id,
      createdVia: "ai",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Thanks — that's a known issue with very large exports. I've re-run yours in the background; you should see it land in a few minutes.",
      at(created, HOUR)
    );
  }

  // --- Scenario 7: staff-logged on behalf of a customer who called in ---
  {
    const customer = customers[16]; // Mostafa
    const agent = agents[7]; // Rania
    const created = daysAgo(5);
    const ticket = await Ticket.create({
      subject: "Requesting a feature: dark mode on mobile",
      description: "Customer called in asking whether dark mode is coming to the mobile app — logging as a feature request.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Feature Request"),
      priority: "low",
      status: "answered",
      statusHistory: [
        { status: "new", changedBy: agent._id, changedAt: created },
        { status: "answered", changedBy: agent._id, changedAt: at(created, 5 * MIN) },
      ],
      // Stays "answered" — must already be breached, see Scenario 4's comment.
      sla: { responseTargetAt: at(created, 2 * HOUR), resolutionTargetAt: at(created, 24 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 90 * MIN) },
        { event: "breached", at: at(created, 2 * HOUR + 5 * MIN) },
      ],
      createdBy: agent._id,
      createdVia: "phone",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Logging this on your behalf per our call — thanks for the suggestion, I've passed it to the product team.",
      created,
      { internal: false }
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Internal note: third request for dark mode on mobile this quarter — worth flagging in the roadmap review.",
      at(created, 5 * MIN),
      { internal: true }
    );
  }

  // --- Scenario 8: long-running ticket, several days, many back-and-forth turns ---
  {
    const customer = customers[1]; // Ahmed
    const agent = agents[0]; // Omar
    const created = daysAgo(11);
    const ticket = await Ticket.create({
      subject: "Recurring sync failures between mobile and web",
      description: "Changes I make on mobile don't show up on web until hours later, sometimes not at all.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Technical Issue"),
      priority: "high",
      status: "closed",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, HOUR) },
        { status: "answered", changedBy: agent._id, changedAt: at(created, DAY) },
        { status: "in_progress", changedBy: customer._id, changedAt: at(created, DAY + 3 * HOUR) },
        { status: "answered", changedBy: agent._id, changedAt: at(created, 3 * DAY) },
        { status: "closed", changedBy: agent._id, changedAt: at(created, 4 * DAY) },
      ],
      sla: { responseTargetAt: at(created, 30 * MIN), resolutionTargetAt: at(created, 4 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 22 * MIN) },
        { event: "breached", at: at(created, 4 * HOUR + 5 * MIN) },
      ],
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    const turns: [MessageSenderType, Types.ObjectId, string, number][] = [
      ["customer", customer._id, ticket.description, 0],
      ["agent", agent._id, "Thanks for the detail — can you tell me roughly how long the delay usually is, and does it happen on Wi-Fi and mobile data both?", HOUR],
      ["customer", customer._id, "Usually 3-4 hours, and yes, both Wi-Fi and mobile data.", HOUR + 40 * MIN],
      ["agent", agent._id, "Got it. I checked your account's sync logs and see several failed sync jobs — looks like it's retrying but silently failing. I'm escalating this to engineering with your log excerpt.", DAY],
      ["customer", customer._id, "Okay — it's still happening today too, for what it's worth.", DAY + 3 * HOUR],
      ["agent", agent._id, "Understood, keeping this open. Engineering identified a bad sync token on your account specifically — I've reset it, could you try again and let me know?", 2 * DAY],
      ["customer", customer._id, "Just tested — changes are syncing within a minute now. Looks fixed!", 2 * DAY + 45 * MIN],
      ["agent", agent._id, "Glad to hear it. I'll keep an eye on your sync logs for the next few days and close this out — reopen if it comes back.", 3 * DAY],
      ["customer", customer._id, "Still working fine, thank you for sticking with it.", 3 * DAY + 6 * HOUR],
      ["agent", agent._id, "Great to hear — closing this ticket now. Reach out any time if it resurfaces.", 4 * DAY],
    ];
    for (const [senderType, senderId, text, offset] of turns) {
      await addMessage("ticket", ticket._id, senderType, senderId, text, at(created, offset));
    }
  }

  // --- Scenario 9: long thread, several attachments referenced in text (no real files stored) ---
  {
    const customer = customers[8]; // Salma
    const agent = agents[2]; // Youssef
    const created = daysAgo(6);
    const ticket = await Ticket.create({
      subject: "Checkout page shows a blank screen on Safari",
      description: "Attaching a screenshot — the checkout page just goes white after I click 'Pay'.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Technical Issue"),
      priority: "high",
      status: "answered",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 20 * MIN) },
        { status: "answered", changedBy: agent._id, changedAt: at(created, 5 * HOUR) },
      ],
      sla: { responseTargetAt: at(created, 30 * MIN), resolutionTargetAt: at(created, 4 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [{ event: "at_risk", at: at(created, 22 * MIN) }],
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Thanks for the screenshot — could you also share the browser console log? Right-click > Inspect > Console, then a screenshot of any red errors.",
      at(created, 20 * MIN)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "customer",
      customer._id,
      "Attached — there's a 'Content Security Policy' error in there, not sure if that's relevant.",
      at(created, HOUR)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "That's exactly the culprit — a CSP rule was blocking our payment widget on Safari specifically. Fix is deployed, could you try again?",
      at(created, 4 * HOUR)
    );
    await addMessage("ticket", ticket._id, "customer", customer._id, "Just checked out successfully, thank you!", at(created, 5 * HOUR));
  }

  // --- Scenario 10: reopened after being closed ---
  {
    const customer = customers[15]; // Emma
    const agent = agents[3]; // Mona
    const created = daysAgo(14);
    const ticket = await Ticket.create({
      subject: "Refund never arrived",
      description: "I was told I'd get a refund for a duplicate charge two weeks ago, still nothing.",
      customer: customer._id,
      assignedAgent: agent._id,
      category: catName("Refunds"),
      priority: "medium",
      status: "in_progress",
      statusHistory: [
        { status: "new", changedBy: customer._id, changedAt: created },
        { status: "answered", changedBy: agent._id, changedAt: at(created, 3 * HOUR) },
        { status: "closed", changedBy: agent._id, changedAt: at(created, DAY) },
        { status: "new", changedBy: customer._id, changedAt: at(created, 9 * DAY) },
        { status: "in_progress", changedBy: agent._id, changedAt: at(created, 9 * DAY + 2 * HOUR) },
      ],
      // Reopened into "in_progress" — must already be breached, see
      // Scenario 4's comment (the ORIGINAL resolution target is 14 days
      // gone; the reopen doesn't get a fresh one).
      sla: { responseTargetAt: at(created, HOUR), resolutionTargetAt: at(created, 8 * HOUR), breached: true, atRiskAlerted: true },
      slaHistory: [
        { event: "at_risk", at: at(created, 45 * MIN) },
        { event: "breached", at: at(created, HOUR + 5 * MIN) },
      ],
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await setTimestamps(Ticket, ticket._id, created);
    await addMessage("ticket", ticket._id, "customer", customer._id, ticket.description, created);
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Confirmed — I've submitted the refund on our end, it should land in 5-7 business days.",
      at(created, 3 * HOUR)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "customer",
      customer._id,
      "It's been more than two weeks now and still no refund on my statement — reopening this.",
      at(created, 9 * DAY)
    );
    await addMessage(
      "ticket",
      ticket._id,
      "agent",
      agent._id,
      "Sorry about that — I see the original refund request stalled on our payment processor's side. Resubmitting manually now and will confirm once it clears.",
      at(created, 9 * DAY + 2 * HOUR)
    );
  }
}

// ---------------------------------------------------------------------------
// Live chats
// ---------------------------------------------------------------------------

const AI_TURNS_TECH = [
  "Hi! I'm having trouble exporting a report — it just spins and fails every time.",
  "Sorry to hear that — could you tell me which report and roughly how large it is (how many rows)?",
  "It's the monthly usage report, probably a few thousand rows.",
  "Thanks. Large exports over 2,000 rows can occasionally time out — I'd suggest trying again in a few minutes, or exporting a smaller date range. Would you like me to open a ticket so the team can look at your account directly?",
  "Yes please, that would help.",
];

async function seedChats(ctx: { agents: IUser[]; customers: IUser[]; faqIds: Record<KbCategorySlug, Types.ObjectId[]>; articleIds: Record<KbCategorySlug, { id: Types.ObjectId; slug: string }[]> }) {
  const { agents, customers, faqIds, articleIds } = ctx;
  let chatTicketSourceConversationId: Types.ObjectId | null = null;

  // --- Chat A: resolved entirely by the AI, short-to-medium ---
  {
    const customer = customers[5]; // Michael — this is the conversation Scenario 6's ticket links back to
    const created = daysAgo(7);
    const convo = await Conversation.create({
      customer: customer._id,
      assignedAgent: null,
      status: "resolved",
      sla: { responseTargetAt: at(created, 5 * MIN), breached: false, atRiskAlerted: false },
      aiTicketSuggestionDeclined: false,
      agentJoinedAnnounced: false,
    });
    await setTimestamps(Conversation, convo._id, created);
    chatTicketSourceConversationId = convo._id;
    const senders: MessageSenderType[] = ["customer", "ai", "customer", "ai", "customer"];
    let offset = 0;
    for (let i = 0; i < AI_TURNS_TECH.length; i++) {
      offset += i === 0 ? 0 : (2 + i) * MIN;
      const isLast = i === AI_TURNS_TECH.length - 1;
      await addMessage(
        "conversation",
        convo._id,
        senders[i],
        senders[i] === "customer" ? customer._id : null,
        AI_TURNS_TECH[i],
        at(created, offset),
        isLast
          ? {}
          : senders[i] === "ai" && i === 3
          ? { aiTicketSuggestion: { subject: "Export feature keeps timing out", description: "Customer's monthly usage report export (~a few thousand rows) fails/times out repeatedly." } }
          : {}
      );
    }
  }

  // --- Chat B: escalated to a human, AI early then agent takes over ---
  {
    const customer = customers[9]; // Chris (inactive account, but the chat happened while still active)
    const agent = agents[1]; // Layla
    const created = daysAgo(20);
    const convo = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
      // Its 5-minute-after-creation response target is necessarily long
      // past for a days-old conversation — set breached up front so the
      // fixture already matches what the live SLA monitor would flip it to
      // on its first scan anyway (same reasoning as the ticket scenarios
      // above; conversations don't get a status forced to "escalated" on
      // breach the way tickets do, but the flag itself still updates).
      sla: { responseTargetAt: at(created, 5 * MIN), breached: true, atRiskAlerted: false },
      aiTicketSuggestionDeclined: true,
      agentJoinedAnnounced: true,
    });
    await setTimestamps(Conversation, convo._id, created);
    const script: [MessageSenderType, Types.ObjectId | null, string, number][] = [
      ["customer", customer._id, "I was charged for two subscriptions this month, that can't be right.", 0],
      [
        "ai",
        null,
        "I can see one active subscription on your account. Let me pull your last two invoices to check for a duplicate charge.",
        2 * MIN,
      ],
      ["ai", null, "I do see two charges dated the same day — that's unusual enough that I'd like to bring in a teammate to review your billing directly.", 4 * MIN],
      ["customer", customer._id, "Okay, thank you.", 5 * MIN],
      ["system", null, "Layla Haddad joined the conversation.", 6 * MIN],
      [
        "agent",
        agent._id,
        "Hi, I'm Layla — I can confirm this was a duplicate charge from our payment processor retrying a failed webhook. I'm refunding the extra charge now.",
        9 * MIN,
      ],
      ["customer", customer._id, "That's a relief, thank you for checking so quickly.", 11 * MIN],
      ["agent", agent._id, "Of course — you should see the refund within 3-5 business days. Anything else I can help with?", 12 * MIN],
      ["customer", customer._id, "No, that's all — appreciate it!", 13 * MIN],
    ];
    for (const [senderType, senderId, text, offset] of script) {
      await addMessage("conversation", convo._id, senderType, senderId, text, at(created, offset));
    }
  }

  // --- Chat C & D: long conversations (30+ messages), mixing AI/agent, KB suggestions ---
  const longChatCustomers = [customers[11], customers[17]]; // Peter, Grace
  const longChatAgents = [agents[5], agents[7]]; // Nour, Rania
  const longChatDaysAgo = [4, 2];
  const topics: { customerLine: string; category: KbCategorySlug }[] = [
    { customerLine: "I keep getting logged out every few minutes, it's making the app unusable.", category: "account-and-profile" },
    { customerLine: "I can't figure out how to change my notification preferences, is that possible?", category: "getting-started" },
  ];

  for (let c = 0; c < longChatCustomers.length; c++) {
    const customer = longChatCustomers[c];
    const agent = longChatAgents[c];
    const created = daysAgo(longChatDaysAgo[c]);
    const convo = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
      // Both already breached — same reasoning as Chat B above.
      sla: { responseTargetAt: at(created, 5 * MIN), breached: true, atRiskAlerted: true },
      aiTicketSuggestionDeclined: false,
      agentJoinedAnnounced: true,
    });
    await setTimestamps(Conversation, convo._id, created);

    const relatedFaqs = faqIds[topics[c].category];
    const relatedArticles = articleIds[topics[c].category];

    const aiReplyPool = [
      "I can help with that — could you tell me a bit more about when this started happening?",
      "Thanks for the detail. Let me check a few things on your account.",
      "I looked into it and here's what I'm seeing on our end so far.",
      "That's a good question — let me check our help center for the exact steps.",
      "I found something that might be exactly what you need, one moment.",
      "Does that resolve it on your end, or is it still happening?",
      "Let me dig a little deeper into your account's recent activity.",
      "I want to make sure I get this exactly right for you, bear with me a moment.",
    ];
    const customerReplyPool = [
      "It's been happening since yesterday, pretty consistently.",
      "I've tried on both my phone and my laptop, same issue on both.",
      "That's interesting, I hadn't noticed that before.",
      "Okay, let me try that now.",
      "Hmm, still seeing the same thing on my end.",
      "Oh, that actually makes sense now.",
      "Is there anything I need to do on my side after that?",
      "Got it, thank you for explaining.",
      "That's helpful context, I appreciate it.",
      "Just to double check, does this affect my other devices too?",
    ];
    const agentReplyPool = [
      "Thanks for bearing with me — I've got your account open now, taking a closer look.",
      "I can confirm what you're seeing, and I want to get this right rather than guess — give me a moment.",
      "Found it — this is a known edge case, here's what's actually happening on our end.",
      "I've made an adjustment on your account, could you try again on your end?",
      "That's expected behavior actually, let me explain why.",
      "Appreciate your patience — this one took a bit of digging.",
      "I'll keep monitoring your account for the next day to make sure this is fully resolved.",
    ];

    let offset = 0;
    let poolIdx = { ai: 0, customer: 0, agent: 0 };
    let msgIdx = 0;

    // Opening: customer states the problem, AI responds first (several AI turns)
    await addMessage("conversation", convo._id, "customer", customer._id, topics[c].customerLine, at(created, offset));
    offset += 2 * MIN;

    const aiTurnCount = 6;
    for (let i = 0; i < aiTurnCount; i++) {
      const isKbTurn = i === 2 && relatedFaqs.length > 0;
      await addMessage(
        "conversation",
        convo._id,
        "ai",
        null,
        aiReplyPool[poolIdx.ai++ % aiReplyPool.length],
        at(created, offset),
        isKbTurn
          ? {
              aiKbSuggestion: {
                type: "faq",
                id: relatedFaqs[0].toString(),
                title: { en: "Related FAQ", ar: "سؤال شائع ذو صلة" },
              },
            }
          : {}
      );
      offset += (2 + (i % 3)) * MIN;
      await addMessage("conversation", convo._id, "customer", customer._id, customerReplyPool[poolIdx.customer++ % customerReplyPool.length], at(created, offset));
      offset += (1 + (i % 2)) * MIN;
    }

    // Escalation hand-off
    await addMessage("conversation", convo._id, "ai", null, "This needs a closer look than I can give — bringing in a teammate now.", at(created, offset));
    offset += 3 * MIN;
    await addMessage("conversation", convo._id, "system", null, `${agent.name} joined the conversation.`, at(created, offset));
    offset += 2 * MIN;

    // Agent takes over, longer back-and-forth including a KB article suggestion
    const agentTurnCount = 8;
    for (let i = 0; i < agentTurnCount; i++) {
      const isArticleTurn = i === 4 && relatedArticles.length > 0;
      await addMessage(
        "conversation",
        convo._id,
        "agent",
        agent._id,
        agentReplyPool[poolIdx.agent++ % agentReplyPool.length],
        at(created, offset),
        isArticleTurn
          ? {
              aiKbSuggestion: {
                type: "article",
                id: relatedArticles[0].id.toString(),
                title: { en: "Related help article", ar: "مقالة مساعدة ذات صلة" },
                slug: relatedArticles[0].slug,
              },
            }
          : {}
      );
      offset += (2 + (i % 4)) * MIN;
      await addMessage("conversation", convo._id, "customer", customer._id, customerReplyPool[poolIdx.customer++ % customerReplyPool.length], at(created, offset));
      offset += (1 + (i % 3)) * MIN;
    }

    await addMessage(
      "conversation",
      convo._id,
      "agent",
      agent._id,
      "Glad we got that sorted — reach out any time if it comes back.",
      at(created, offset)
    );
    offset += MIN;
    await addMessage("conversation", convo._id, "customer", customer._id, "Will do, thanks for all the help today!", at(created, offset));
  }

  return { chatTicketSourceConversationId: chatTicketSourceConversationId! };
}

// ---------------------------------------------------------------------------
// Knowledge base: FAQs + help articles, every category
// ---------------------------------------------------------------------------

interface FaqSeed {
  question: { en: string; ar: string };
  answer: { en: string; ar: string };
}
interface ArticleSeed {
  slug: string;
  title: { en: string; ar: string };
  summary: { en: string; ar: string };
  body: { en: string; ar: string };
}

const KB_CONTENT: Record<KbCategorySlug, { faqs: FaqSeed[]; articles: ArticleSeed[] }> = {
  "getting-started": {
    faqs: [
      {
        question: { en: "How do I create an account?", ar: "كيف أنشئ حسابًا؟" },
        answer: {
          en: "Click \"Sign up\" from the top navigation, enter your name, email, and a password, and you're in — no email confirmation required to start using the app.",
          ar: "اضغط على \"إنشاء حساب\" من القائمة العلوية، أدخل اسمك وبريدك الإلكتروني وكلمة مرور، وستكون جاهزًا للبدء دون الحاجة لتأكيد البريد الإلكتروني.",
        },
      },
      {
        question: { en: "What's the difference between a ticket and a live chat?", ar: "ما الفرق بين التذكرة والدردشة المباشرة؟" },
        answer: {
          en: "Live chat is answered instantly by our AI agent, with a human stepping in when needed — best for quick questions. A ticket is answered by a human and the reply is emailed to you — best for anything that can wait or needs documentation.",
          ar: "الدردشة المباشرة يتم الرد عليها فورًا بواسطة الذكاء الاصطناعي، مع تدخل موظف عند الحاجة — وهي الأنسب للأسئلة السريعة. أما التذكرة فيتم الرد عليها من قِبل موظف ويصلك الرد عبر البريد الإلكتروني — وهي الأنسب لأي أمر يمكن الانتظار فيه أو يحتاج إلى توثيق.",
        },
      },
      {
        question: { en: "Is the platform available in Arabic?", ar: "هل المنصة متاحة باللغة العربية؟" },
        answer: {
          en: "Yes — switch languages any time from the user menu in the top right. The whole interface, including right-to-left layout, updates immediately.",
          ar: "نعم — يمكنك تبديل اللغة في أي وقت من قائمة المستخدم أعلى يمين الصفحة. تتحدث الواجهة بالكامل فورًا، بما في ذلك اتجاه الكتابة من اليمين لليسار.",
        },
      },
    ],
    articles: [
      {
        slug: "getting-started-with-your-account",
        title: { en: "Getting started with your account", ar: "البدء باستخدام حسابك" },
        summary: {
          en: "A quick tour of what you can do right after signing up.",
          ar: "جولة سريعة على ما يمكنك فعله فور إنشاء حسابك.",
        },
        body: {
          en:
            "## Welcome\n\nOnce you've signed up, here's what's available to you right away:\n\n- Start a **live chat** for an instant, AI-first answer\n- Submit a **ticket** for anything that can wait for a human reply by email\n- Browse the **Help Center** for FAQs and step-by-step guides\n- Update your profile and language preference from the user menu\n\n## Next steps\n\nMost customers start with a live chat for their first question — it's the fastest way to get an answer, and if the AI agent can't fully resolve it, a human teammate is brought into the same conversation automatically.",
          ar:
            "## أهلاً بك\n\nبمجرد إنشاء حسابك، إليك ما يمكنك القيام به فورًا:\n\n- بدء **دردشة مباشرة** للحصول على إجابة فورية من الذكاء الاصطناعي\n- إرسال **تذكرة** لأي أمر يمكن الانتظار فيه للرد عليه من قِبل موظف عبر البريد الإلكتروني\n- تصفح **مركز المساعدة** للأسئلة الشائعة والأدلة التفصيلية\n- تحديث ملفك الشخصي وتفضيلات اللغة من قائمة المستخدم\n\n## الخطوات التالية\n\nيبدأ معظم العملاء بدردشة مباشرة لسؤالهم الأول — فهي أسرع طريقة للحصول على إجابة، وإذا لم يستطع الذكاء الاصطناعي حل المشكلة بالكامل، ينضم أحد الموظفين إلى نفس المحادثة تلقائيًا.",
        },
      },
      {
        slug: "navigating-the-dashboard",
        title: { en: "Navigating the dashboard", ar: "التنقل في لوحة التحكم" },
        summary: {
          en: "Where to find your tickets, chats, and account settings.",
          ar: "أين تجد تذاكرك ومحادثاتك وإعدادات حسابك.",
        },
        body: {
          en:
            "## The main navigation\n\nEverything is reachable from the top bar:\n\n1. **Get support** — start a new ticket or live chat\n2. **Help** — browse FAQs and articles\n3. **User menu** — profile, theme, language, and logging out\n\nSigned-in customers land on the support page by default, so starting a new conversation is always one click away.",
          ar:
            "## القائمة الرئيسية\n\nكل شيء متاح من الشريط العلوي:\n\n1. **الحصول على الدعم** — بدء تذكرة أو دردشة مباشرة جديدة\n2. **المساعدة** — تصفح الأسئلة الشائعة والمقالات\n3. **قائمة المستخدم** — الملف الشخصي، المظهر، اللغة، وتسجيل الخروج\n\nيتم توجيه العملاء المسجلين إلى صفحة الدعم افتراضيًا، بحيث يكون بدء محادثة جديدة دائمًا على بُعد نقرة واحدة.",
        },
      },
    ],
  },
  "account-and-profile": {
    faqs: [
      {
        question: { en: "How do I change my email address?", ar: "كيف أغيّر بريدي الإلكتروني؟" },
        answer: {
          en: "Go to Settings, enter your new email, and we'll send a confirmation link to it. Your email only changes once you click that link — until then, your old email keeps working.",
          ar: "اذهب إلى الإعدادات، أدخل بريدك الإلكتروني الجديد، وسنرسل رابط تأكيد إليه. لن يتغير بريدك الإلكتروني إلا بعد الضغط على هذا الرابط — وحتى ذلك الحين، سيستمر بريدك القديم في العمل.",
        },
      },
      {
        question: { en: "Why do I keep getting logged out?", ar: "لماذا يتم تسجيل خروجي باستمرار؟" },
        answer: {
          en: "Your session refreshes automatically in the background as long as you're active. If you're logged out unexpectedly, it's usually because of an extended period of inactivity — simply log back in.",
          ar: "يتم تحديث جلستك تلقائيًا في الخلفية طالما أنك نشط. إذا تم تسجيل خروجك بشكل غير متوقع، فذلك عادةً بسبب فترة طويلة من عدم النشاط — ما عليك سوى تسجيل الدخول مرة أخرى.",
        },
      },
      {
        question: { en: "Can I delete my account?", ar: "هل يمكنني حذف حسابي؟" },
        answer: {
          en: "Contact support through a ticket and we'll take care of it — account deletion isn't yet self-service, but our team can process the request quickly.",
          ar: "تواصل مع الدعم عبر تذكرة وسنتولى الأمر — حذف الحساب ليس متاحًا حاليًا كخدمة ذاتية، ولكن فريقنا يمكنه معالجة الطلب بسرعة.",
        },
      },
    ],
    articles: [
      {
        slug: "updating-your-profile",
        title: { en: "Updating your profile", ar: "تحديث ملفك الشخصي" },
        summary: {
          en: "How to change your name, phone number, and language preference.",
          ar: "كيفية تغيير اسمك ورقم هاتفك وتفضيل اللغة.",
        },
        body: {
          en:
            "## Editable fields\n\nFrom Settings you can update:\n\n- Display name\n- Phone number\n- Preferred language\n\n## What requires confirmation\n\nChanging your **email address** is the one exception — a confirmation link is sent to the new address first, and the change only takes effect once you click it.",
          ar:
            "## الحقول القابلة للتعديل\n\nمن الإعدادات يمكنك تحديث:\n\n- الاسم المعروض\n- رقم الهاتف\n- اللغة المفضلة\n\n## ما يتطلب تأكيدًا\n\nتغيير **البريد الإلكتروني** هو الاستثناء الوحيد — يتم إرسال رابط تأكيد إلى العنوان الجديد أولاً، ولا يسري التغيير إلا بعد الضغط عليه.",
        },
      },
      {
        slug: "staying-signed-in",
        title: { en: "Staying signed in", ar: "البقاء مسجلاً للدخول" },
        summary: {
          en: "How sessions work and what to do if you're logged out unexpectedly.",
          ar: "كيف تعمل الجلسات وماذا تفعل إذا تم تسجيل خروجك بشكل غير متوقع.",
        },
        body: {
          en:
            "## How sessions work\n\nYour session is kept alive automatically in the background while you're active. There's nothing you need to do to stay signed in during normal use.\n\n## If you get logged out\n\n1. Simply log back in with your email and password\n2. If it keeps happening on the same device, check that cookies aren't being blocked for this site\n\nYour data is never affected by being logged out — it's purely a session issue.",
          ar:
            "## كيف تعمل الجلسات\n\nيتم الحفاظ على جلستك تلقائيًا في الخلفية أثناء نشاطك. لا حاجة لفعل أي شيء للبقاء مسجلاً أثناء الاستخدام العادي.\n\n## إذا تم تسجيل خروجك\n\n1. ببساطة سجّل الدخول مرة أخرى ببريدك الإلكتروني وكلمة المرور\n2. إذا استمر حدوث ذلك على نفس الجهاز، تحقق من أن ملفات تعريف الارتباط غير محظورة لهذا الموقع\n\nبياناتك لا تتأثر أبدًا بتسجيل الخروج — فالأمر مجرد مشكلة في الجلسة.",
        },
      },
    ],
  },
  "tickets-and-support": {
    faqs: [
      {
        question: { en: "How long does it take to get a reply to my ticket?", ar: "كم من الوقت يستغرق الرد على تذكرتي؟" },
        answer: {
          en: "Response times depend on the priority of your issue, but most tickets get a first reply within a few hours. You'll be notified by email the moment an agent responds.",
          ar: "تعتمد أوقات الرد على أولوية مشكلتك، لكن معظم التذاكر تحصل على أول رد خلال ساعات قليلة. سيتم إشعارك عبر البريد الإلكتروني فور رد أحد الموظفين.",
        },
      },
      {
        question: { en: "Can I reopen a closed ticket?", ar: "هل يمكنني إعادة فتح تذكرة مغلقة؟" },
        answer: {
          en: "Yes — just reply on the ticket and it automatically reopens for the assigned agent to follow up.",
          ar: "نعم — فقط قم بالرد على التذكرة وستُعاد فتحها تلقائيًا ليتابعها الموظف المسؤول.",
        },
      },
      {
        question: { en: "Can I attach a screenshot to my ticket?", ar: "هل يمكنني إرفاق لقطة شاشة بتذكرتي؟" },
        answer: {
          en: "Yes, both when creating a ticket and when replying to one — attachments help our agents diagnose issues much faster.",
          ar: "نعم، سواء عند إنشاء التذكرة أو عند الرد عليها — المرفقات تساعد موظفينا على تشخيص المشكلات بشكل أسرع بكثير.",
        },
      },
    ],
    articles: [
      {
        slug: "how-tickets-are-handled",
        title: { en: "How tickets are handled", ar: "كيف يتم التعامل مع التذاكر" },
        summary: {
          en: "From submission to a reply in your inbox.",
          ar: "من الإرسال إلى الرد في بريدك الوارد.",
        },
        body: {
          en:
            "## The lifecycle of a ticket\n\n1. You submit a ticket with a subject and description\n2. It's automatically routed to an available agent\n3. The agent replies — you're notified by email\n4. Once resolved, the ticket is closed; replying to it reopens it automatically\n\n## Priorities\n\nTickets are tagged Low, Medium, High, or Urgent. Higher-priority tickets are held to tighter response targets internally, so flag anything genuinely urgent as such.",
          ar:
            "## دورة حياة التذكرة\n\n1. تقوم بإرسال تذكرة تحتوي على عنوان ووصف\n2. يتم توجيهها تلقائيًا إلى موظف متاح\n3. يقوم الموظف بالرد — ويصلك إشعار عبر البريد الإلكتروني\n4. بمجرد حل المشكلة، تُغلق التذكرة؛ والرد عليها يعيد فتحها تلقائيًا\n\n## الأولويات\n\nتُصنَّف التذاكر إلى منخفضة، متوسطة، عالية، أو عاجلة. التذاكر ذات الأولوية الأعلى تخضع داخليًا لأهداف استجابة أضيق، لذا يُرجى تصنيف أي أمر عاجل فعليًا على هذا الأساس.",
        },
      },
      {
        slug: "attaching-files-to-a-ticket",
        title: { en: "Attaching files to a ticket", ar: "إرفاق ملفات بالتذكرة" },
        summary: {
          en: "Screenshots and documents you can include when submitting or replying.",
          ar: "لقطات الشاشة والمستندات التي يمكنك إرفاقها عند الإرسال أو الرد.",
        },
        body: {
          en:
            "## When to attach a file\n\nAttachments are most useful for:\n\n- Screenshots of an error message\n- A browser console log\n- A document or invoice you're referencing\n\n## How\n\nUse the attachment button next to the message box, either when creating the ticket or replying to it. There's no limit on how many messages can carry an attachment.",
          ar:
            "## متى ترفق ملفًا\n\nتكون المرفقات مفيدة بشكل خاص في:\n\n- لقطات شاشة لرسالة خطأ\n- سجل وحدة التحكم في المتصفح\n- مستند أو فاتورة تشير إليها\n\n## الطريقة\n\nاستخدم زر الإرفاق بجانب مربع الرسالة، سواء عند إنشاء التذكرة أو الرد عليها. لا يوجد حد لعدد الرسائل التي يمكن أن تحمل مرفقًا.",
        },
      },
    ],
  },
  "live-chat": {
    faqs: [
      {
        question: { en: "Is live chat available 24/7?", ar: "هل الدردشة المباشرة متاحة على مدار الساعة؟" },
        answer: {
          en: "Yes — the AI agent is always available. It brings in a human teammate whenever the conversation needs one, during their working hours.",
          ar: "نعم — الذكاء الاصطناعي متاح دائمًا. ويُشرك أحد الموظفين كلما احتاجت المحادثة إلى ذلك، خلال ساعات عمله.",
        },
      },
      {
        question: { en: "Will I lose context if the AI hands off to a human?", ar: "هل سأفقد سياق المحادثة عند تحويلها إلى موظف بشري؟" },
        answer: {
          en: "No — the human agent joins the exact same conversation thread and can see everything you and the AI already discussed. You never have to repeat yourself.",
          ar: "لا — ينضم الموظف البشري إلى نفس خيط المحادثة تمامًا ويمكنه رؤية كل ما ناقشته أنت والذكاء الاصطناعي بالفعل. لن تضطر أبدًا لتكرار كلامك.",
        },
      },
      {
        question: { en: "Can the AI agent open a ticket for me?", ar: "هل يمكن للذكاء الاصطناعي فتح تذكرة نيابة عني؟" },
        answer: {
          en: "Yes — if your issue is better suited to a ticket, the AI will offer to open one for you directly from the chat, pre-filled with the details you already shared.",
          ar: "نعم — إذا كانت مشكلتك أنسب لتذكرة، سيعرض عليك الذكاء الاصطناعي فتح واحدة مباشرة من الدردشة، مع تعبئة التفاصيل التي شاركتها بالفعل.",
        },
      },
    ],
    articles: [
      {
        slug: "how-live-chat-works",
        title: { en: "How live chat works", ar: "كيف تعمل الدردشة المباشرة" },
        summary: {
          en: "AI-first, human-backed — what to expect from a live chat.",
          ar: "الذكاء الاصطناعي أولاً، مدعومًا بموظف بشري — ما يمكن توقعه من الدردشة المباشرة.",
        },
        body: {
          en:
            "## AI first\n\nEvery live chat starts with our AI agent, which can:\n\n- Answer common questions instantly\n- Look up information on your account\n- Suggest relevant help articles or FAQs\n\n## Escalating to a human\n\nWhen a conversation needs judgment, account access, or an apology a script can't give, the AI escalates to the team automatically — in the same thread, with full context.\n\n## After the chat\n\nA transcript of the whole conversation, AI and human parts included, stays available to you afterward.",
          ar:
            "## الذكاء الاصطناعي أولاً\n\nتبدأ كل دردشة مباشرة بمساعد الذكاء الاصطناعي، والذي يمكنه:\n\n- الإجابة على الأسئلة الشائعة فورًا\n- الاطلاع على معلومات حسابك\n- اقتراح مقالات مساعدة أو أسئلة شائعة ذات صلة\n\n## التحويل إلى موظف بشري\n\nعندما تحتاج المحادثة إلى تقدير أو صلاحية وصول إلى الحساب أو اعتذار لا يستطيع نص جاهز تقديمه، يقوم الذكاء الاصطناعي بتحويلها تلقائيًا إلى الفريق — في نفس الخيط، مع كامل السياق.\n\n## بعد الدردشة\n\nيبقى نص المحادثة كاملاً، بجزأيها الآلي والبشري، متاحًا لك بعد ذلك.",
        },
      },
      {
        slug: "when-to-use-live-chat-vs-a-ticket",
        title: { en: "When to use live chat vs. a ticket", ar: "متى تستخدم الدردشة المباشرة بدلاً من التذكرة" },
        summary: {
          en: "Picking the right channel for your question.",
          ar: "اختيار القناة المناسبة لسؤالك.",
        },
        body: {
          en:
            "## Use live chat when\n\n- You need an answer right now\n- Your question is quick or common\n- You want to go back and forth in real time\n\n## Use a ticket when\n\n- Your issue can wait for a reply by email\n- You need to attach several documents\n- You'd rather not stay online waiting for a response\n\nEither way, you can always switch — the AI agent can open a ticket for you mid-chat if that turns out to be the better fit.",
          ar:
            "## استخدم الدردشة المباشرة عندما\n\n- تحتاج إلى إجابة الآن\n- سؤالك سريع أو شائع\n- تريد تبادل الحديث في الوقت الفعلي\n\n## استخدم التذكرة عندما\n\n- يمكن لمشكلتك الانتظار للرد عبر البريد الإلكتروني\n- تحتاج إلى إرفاق عدة مستندات\n- تفضل عدم البقاء متصلاً في انتظار الرد\n\nفي كل الأحوال، يمكنك دائمًا التبديل — يمكن للذكاء الاصطناعي فتح تذكرة نيابة عنك أثناء الدردشة إذا تبين أنها الخيار الأنسب.",
        },
      },
    ],
  },
  "billing-and-payments": {
    faqs: [
      {
        question: { en: "What payment methods are accepted?", ar: "ما هي طرق الدفع المقبولة؟" },
        answer: {
          en: "We accept major credit and debit cards. Payment details are managed securely and are never visible to support staff.",
          ar: "نقبل بطاقات الائتمان والخصم الرئيسية. تُدار تفاصيل الدفع بشكل آمن ولا تكون مرئية أبدًا لموظفي الدعم.",
        },
      },
      {
        question: { en: "Why was I charged twice?", ar: "لماذا تم تحصيل المبلغ مرتين؟" },
        answer: {
          en: "This is usually a duplicate charge from a retried payment. Open a ticket with the dates of both charges and our billing team will refund the duplicate quickly.",
          ar: "عادةً ما يكون هذا رسمًا مكررًا ناتجًا عن إعادة محاولة الدفع. افتح تذكرة مع تواريخ كلا الرسمين وسيقوم فريق الفوترة لدينا برد المبلغ المكرر بسرعة.",
        },
      },
      {
        question: { en: "How do I update my billing address?", ar: "كيف أحدّث عنوان الفوترة الخاص بي؟" },
        answer: {
          en: "Open a ticket with your new address and an agent will update it on your account — it'll show correctly on your next invoice.",
          ar: "افتح تذكرة تحتوي على عنوانك الجديد وسيقوم أحد الموظفين بتحديثه في حسابك — وسيظهر بشكل صحيح في فاتورتك القادمة.",
        },
      },
    ],
    articles: [
      {
        slug: "understanding-your-invoice",
        title: { en: "Understanding your invoice", ar: "فهم فاتورتك" },
        summary: {
          en: "What each line on your invoice means.",
          ar: "ماذا يعني كل بند في فاتورتك.",
        },
        body: {
          en:
            "## Reading your invoice\n\nEach invoice lists:\n\n- The billing period it covers\n- Your plan and any add-ons\n- Taxes, where applicable\n\n## If something looks wrong\n\nOpen a ticket under **Billing** with the invoice date — our team can walk through it line by line with you.",
          ar:
            "## قراءة فاتورتك\n\nتحتوي كل فاتورة على:\n\n- فترة الفوترة التي تغطيها\n- خطتك وأي إضافات\n- الضرائب، عند انطباقها\n\n## إذا بدا شيء غير صحيح\n\nافتح تذكرة تحت تصنيف **الفوترة** مع تاريخ الفاتورة — يمكن لفريقنا مراجعتها معك بندًا بندًا.",
        },
      },
      {
        slug: "requesting-a-refund",
        title: { en: "Requesting a refund", ar: "طلب استرداد الأموال" },
        summary: {
          en: "How refunds work and how long they take.",
          ar: "كيف تعمل عملية الاسترداد وكم تستغرق من الوقت.",
        },
        body: {
          en:
            "## How to request one\n\nOpen a ticket under **Refunds** describing the charge in question. Our team reviews each request individually.\n\n## Timing\n\nOnce approved, refunds typically appear on your statement within 5-7 business days, depending on your bank.",
          ar:
            "## كيفية الطلب\n\nافتح تذكرة تحت تصنيف **الاسترداد** تصف الرسم المعني. يقوم فريقنا بمراجعة كل طلب على حدة.\n\n## المدة الزمنية\n\nبمجرد الموافقة، يظهر الاسترداد عادةً في كشف حسابك خلال 5-7 أيام عمل، حسب البنك الذي تتعامل معه.",
        },
      },
    ],
  },
  troubleshooting: {
    faqs: [
      {
        question: { en: "The page won't load, what should I try first?", ar: "الصفحة لا تُحمّل، ماذا أجرب أولاً؟" },
        answer: {
          en: "Try a hard refresh (Ctrl/Cmd + Shift + R) and, if that doesn't help, clearing your browser cache. If it still fails, open a ticket with a screenshot.",
          ar: "جرّب إعادة تحميل قوية (Ctrl/Cmd + Shift + R)، وإذا لم يساعد ذلك، امسح ذاكرة التخزين المؤقت للمتصفح. إذا استمرت المشكلة، افتح تذكرة مع لقطة شاشة.",
        },
      },
      {
        question: { en: "Why do my changes take a while to appear on another device?", ar: "لماذا تستغرق تغييراتي وقتًا لتظهر على جهاز آخر؟" },
        answer: {
          en: "Changes sync automatically within a minute or two under normal conditions. If it's taking noticeably longer, try logging out and back in on the affected device.",
          ar: "تتم مزامنة التغييرات تلقائيًا خلال دقيقة أو دقيقتين في الظروف العادية. إذا استغرق الأمر وقتًا أطول بشكل ملحوظ، حاول تسجيل الخروج ثم الدخول مرة أخرى على الجهاز المتأثر.",
        },
      },
      {
        question: { en: "I found a bug, how do I report it?", ar: "وجدت خطأً برمجيًا، كيف أبلغ عنه؟" },
        answer: {
          en: "Open a ticket under Technical Issue with steps to reproduce it and, if possible, a screenshot — that's the fastest way for us to fix it.",
          ar: "افتح تذكرة تحت تصنيف مشكلة تقنية مع خطوات إعادة إنتاج المشكلة، وإن أمكن لقطة شاشة — فهذه أسرع طريقة لنا لإصلاحها.",
        },
      },
    ],
    articles: [
      {
        slug: "common-sync-issues",
        title: { en: "Common sync issues", ar: "مشكلات المزامنة الشائعة" },
        summary: {
          en: "Why changes might not show up right away, and how to fix it.",
          ar: "لماذا قد لا تظهر التغييرات فورًا، وكيفية إصلاح ذلك.",
        },
        body: {
          en:
            "## Normal sync behavior\n\nChanges made on one device typically sync to others within a minute or two.\n\n## If it's slower than that\n\n1. Check your internet connection\n2. Log out and back in on the affected device\n3. If it's still delayed after that, open a ticket — this can sometimes point to an account-specific sync issue our team needs to reset.",
          ar:
            "## سلوك المزامنة الطبيعي\n\nتتم مزامنة التغييرات التي تُجرى على جهاز واحد مع الأجهزة الأخرى عادةً خلال دقيقة أو دقيقتين.\n\n## إذا كانت أبطأ من ذلك\n\n1. تحقق من اتصالك بالإنترنت\n2. سجّل الخروج ثم الدخول مرة أخرى على الجهاز المتأثر\n3. إذا استمر التأخير بعد ذلك، افتح تذكرة — فقد يشير هذا أحيانًا إلى مشكلة مزامنة خاصة بحسابك يحتاج فريقنا إلى إعادة ضبطها.",
        },
      },
      {
        slug: "browser-compatibility",
        title: { en: "Browser compatibility", ar: "توافق المتصفح" },
        summary: {
          en: "Supported browsers and what to do if something looks broken.",
          ar: "المتصفحات المدعومة وما يجب فعله إذا بدا شيء معطلاً.",
        },
        body: {
          en:
            "## Supported browsers\n\nThe latest versions of Chrome, Firefox, Safari, and Edge are all fully supported.\n\n## If something looks broken\n\n- Try a hard refresh first\n- Check whether an ad-blocker or privacy extension might be interfering\n- If it's still broken, a browser console screenshot on your ticket helps us diagnose it fast.",
          ar:
            "## المتصفحات المدعومة\n\nأحدث إصدارات كروم وفايرفوكس وسفاري وإيدج مدعومة بالكامل.\n\n## إذا بدا شيء معطلاً\n\n- جرّب إعادة تحميل قوية أولاً\n- تحقق مما إذا كان أحد مانعات الإعلانات أو إضافات الخصوصية يتسبب في تعارض\n- إذا استمرت المشكلة، فإن إرفاق لقطة شاشة لوحدة تحكم المتصفح في تذكرتك يساعدنا على التشخيص بسرعة.",
        },
      },
    ],
  },
  "privacy-and-security": {
    faqs: [
      {
        question: { en: "Is my data encrypted?", ar: "هل بياناتي مشفرة؟" },
        answer: {
          en: "Yes — all data is encrypted in transit, and passwords are never stored in plain text.",
          ar: "نعم — جميع البيانات مشفرة أثناء النقل، ولا تُخزَّن كلمات المرور أبدًا كنص عادي.",
        },
      },
      {
        question: { en: "Who can see my tickets and chats?", ar: "من يمكنه رؤية تذاكري ومحادثاتي؟" },
        answer: {
          en: "Only you, the agent assigned to your case, and admins with oversight access. Support staff never see your payment details.",
          ar: "أنت فقط، والموظف المسؤول عن حالتك، والمسؤولون المخوّلون بالإشراف. لا يرى موظفو الدعم أبدًا تفاصيل الدفع الخاصة بك.",
        },
      },
      {
        question: { en: "How do I report a security concern?", ar: "كيف أبلغ عن مخاوف أمنية؟" },
        answer: {
          en: "Open a ticket marked Urgent under Technical Issue — security-related reports are treated with the highest priority.",
          ar: "افتح تذكرة بأولوية عاجلة تحت تصنيف مشكلة تقنية — يتم التعامل مع البلاغات الأمنية بأعلى أولوية.",
        },
      },
    ],
    articles: [
      {
        slug: "how-we-protect-your-data",
        title: { en: "How we protect your data", ar: "كيف نحمي بياناتك" },
        summary: {
          en: "An overview of our security practices.",
          ar: "نظرة عامة على ممارساتنا الأمنية.",
        },
        body: {
          en:
            "## Encryption\n\nAll traffic to and from the platform is encrypted. Passwords are hashed, never stored as plain text.\n\n## Access control\n\n- Your data is visible only to you, your assigned agent, and admins with oversight access\n- Staff accounts are individually permissioned — not every staff member can see everything\n\n## Reporting a concern\n\nIf you spot something that looks like a security issue, open an Urgent ticket under Technical Issue and it will be prioritized immediately.",
          ar:
            "## التشفير\n\nجميع البيانات المتبادلة مع المنصة مشفرة. تُحفظ كلمات المرور بشكل مُجزَّأ (hashed) ولا تُخزَّن أبدًا كنص عادي.\n\n## التحكم في الوصول\n\n- بياناتك مرئية فقط لك، وللموظف المسؤول عنك، وللمسؤولين المخوّلين بالإشراف\n- حسابات الموظفين لها صلاحيات فردية — ليس بإمكان كل موظف رؤية كل شيء\n\n## الإبلاغ عن مخاوف\n\nإذا لاحظت شيئًا يبدو وكأنه مشكلة أمنية، افتح تذكرة عاجلة تحت تصنيف مشكلة تقنية وستتم معالجتها فورًا كأولوية.",
        },
      },
      {
        slug: "keeping-your-account-secure",
        title: { en: "Keeping your account secure", ar: "الحفاظ على أمان حسابك" },
        summary: {
          en: "Simple steps to reduce the risk of unauthorized access.",
          ar: "خطوات بسيطة لتقليل خطر الوصول غير المصرح به.",
        },
        body: {
          en:
            "## Good habits\n\n- Use a unique password you don't reuse elsewhere\n- Don't share your login details, even with a teammate\n- If you notice activity on your account you don't recognize, open a ticket immediately\n\n## If you're locked out\n\nUse the password reset flow from the login page — if that doesn't work, our support team can help you regain access after verifying your identity.",
          ar:
            "## عادات جيدة\n\n- استخدم كلمة مرور فريدة لا تستخدمها في أماكن أخرى\n- لا تشارك بيانات تسجيل الدخول الخاصة بك، حتى مع أحد الزملاء\n- إذا لاحظت نشاطًا في حسابك لا تتعرف عليه، افتح تذكرة فورًا\n\n## إذا كنت مُقفلاً خارج حسابك\n\nاستخدم آلية إعادة تعيين كلمة المرور من صفحة تسجيل الدخول — إذا لم تنجح، يمكن لفريق الدعم لدينا مساعدتك على استعادة الوصول بعد التحقق من هويتك.",
        },
      },
    ],
  },
};

async function seedKb(authorId: Types.ObjectId) {
  const faqIds: Record<KbCategorySlug, Types.ObjectId[]> = {} as any;
  const articleIds: Record<KbCategorySlug, { id: Types.ObjectId; slug: string }[]> = {} as any;

  for (const category of KB_CATEGORY_SLUGS) {
    const content = KB_CONTENT[category];
    const faqDocs = await Faq.insertMany(
      content.faqs.map((f) => ({ question: f.question, answer: f.answer, category, createdBy: authorId, updatedBy: authorId }))
    );
    faqIds[category] = faqDocs.map((d) => d._id as Types.ObjectId);

    const articleDocs = await HelpArticle.insertMany(
      content.articles.map((a) => ({
        slug: a.slug,
        title: a.title,
        summary: a.summary,
        body: a.body,
        category,
        createdBy: authorId,
        updatedBy: authorId,
      }))
    );
    articleIds[category] = articleDocs.map((d) => ({ id: d._id as Types.ObjectId, slug: d.slug }));
  }

  return { faqIds, articleIds };
}

// ---------------------------------------------------------------------------
// Export every collection to backend/seed-data/*.json for commit-to-repo use
// (see backend/scripts/import-demo-data.ts, the fast path anyone cloning the
// repo actually runs).
// ---------------------------------------------------------------------------

const EXPORTABLE_MODELS = [
  { name: "users", model: User },
  { name: "ticketCategories", model: TicketCategory },
  { name: "slaTargets", model: SlaTarget },
  { name: "slaSystemSettings", model: SlaSystemSettings },
  { name: "tickets", model: Ticket },
  { name: "conversations", model: Conversation },
  { name: "messages", model: Message },
  { name: "faqs", model: Faq },
  { name: "helpArticles", model: HelpArticle },
] as const;

// Minimal Extended-JSON-ish encoding: ObjectId -> {"$oid": "..."}, Date ->
// {"$date": "ISO string"} — just enough round-tripping for
// import-demo-data.ts, not a general BSON serializer.
//
// Done as an explicit recursive walk BEFORE JSON.stringify, NOT as a
// stringify `replacer` function — both ObjectId and Date define their own
// `toJSON()`, and JSON.stringify always calls a value's own `toJSON()` and
// hands the *result* to the replacer, never the original object. A
// replacer-based version of this never actually saw an ObjectId/Date
// instance (only the already-stringified hex/ISO string), so it silently
// no-opped: the emitted fixtures stored `_id` and every ref field as plain
// strings, and importing them back inserted documents whose `_id` was a
// string instead of a real ObjectId — which look identical to a human
// skimming the JSON, but a string `_id` doesn't match the ObjectId-typed
// queries the rest of the app uses everywhere, so anything touching a
// re-imported document (e.g. the SLA monitor's findById → save) failed with
// a VersionError/DocumentNotFoundError. Caught by actually round-tripping
// seed-demo-full.ts's own output through import-demo-data.ts against a live
// server before trusting this — see the commit this shipped in.
function toExtendedJson(value: unknown): unknown {
  if (value instanceof mongoose.Types.ObjectId) return { $oid: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(toExtendedJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toExtendedJson(v);
    return out;
  }
  return value;
}

async function exportFixtures() {
  fs.mkdirSync(SEED_DATA_DIR, { recursive: true });
  for (const { name, model } of EXPORTABLE_MODELS) {
    const docs = await model.find({}).lean();
    const transformed = docs.map(toExtendedJson);
    fs.writeFileSync(path.join(SEED_DATA_DIR, `${name}.json`), JSON.stringify(transformed, null, 2) + "\n");
    console.log(`[seed-demo-full] exported ${docs.length} ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed-demo-full] refusing to wipe the database with NODE_ENV=production");
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Copy backend/.env.example to backend/.env and fill it in.");
  }
  await mongoose.connect(uri);

  console.log("[seed-demo-full] wiping database...");
  await Promise.all([
    User.deleteMany({}),
    Ticket.deleteMany({}),
    Conversation.deleteMany({}),
    Message.deleteMany({}),
    Faq.deleteMany({}),
    HelpArticle.deleteMany({}),
    TicketCategory.deleteMany({}),
    SlaTarget.deleteMany({}),
    SlaSystemSettings.deleteMany({}),
    Notification.deleteMany({}),
    RefreshFamily.deleteMany({}),
  ]);
  await mongoose.connection.collection("counters").deleteMany({});

  console.log("[seed-demo-full] seeding accounts...");
  const { admin1, admin2, subadmin, agents, customers, demoCustomer } = await seedAccounts();

  console.log("[seed-demo-full] seeding reference data...");
  const categories = await seedCategories();
  await seedSla(admin1._id as Types.ObjectId);

  console.log("[seed-demo-full] seeding knowledge base...");
  const { faqIds, articleIds } = await seedKb(admin1._id as Types.ObjectId);

  console.log("[seed-demo-full] seeding live chats...");
  const { chatTicketSourceConversationId } = await seedChats({ agents, customers, faqIds, articleIds });

  console.log("[seed-demo-full] seeding tickets...");
  await seedTickets({ categories, admin1, admin2, agents, customers, chatConversationId: chatTicketSourceConversationId });

  console.log("[seed-demo-full] exporting fixtures...");
  await exportFixtures();

  console.log("\n[seed-demo-full] done. Seeded accounts (email / password):\n");
  for (const c of CREDENTIALS) {
    console.log(`  ${c.role.padEnd(9)} ${c.email.padEnd(30)} ${c.password}`);
  }
  console.log(`\n[seed-demo-full] demo customer: ${demoCustomer.email} / Demo@12345`);
  console.log(`[seed-demo-full] fixtures written to ${SEED_DATA_DIR}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed-demo-full] failed:", err);
  process.exit(1);
});
