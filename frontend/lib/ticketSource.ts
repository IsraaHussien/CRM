// Extracted from frontend/app/tickets/StaffTicketQueue.tsx (ticket-management
// Story 63) so reports-management Story 40's ticket-reports page can reuse
// the exact same labels/emoji/colors for its "by source" chart instead of
// duplicating them — see CLAUDE.md's design-system rule against inventing a
// second palette for the same concept. Values are unchanged from the
// original — moving this file must not change StaffTicketQueue.tsx's
// rendering.
export type TicketCreationChannel = "customer_portal" | "ai" | "phone" | "email" | "in_person" | "other";

// The source badge is provenance, not an SLA/ticket status, so it
// deliberately does not reach for --success/--warning/--destructive — each
// channel instead gets its own emoji + vivid color (globals.css's
// --channel-* tokens) so the column reads at a glance instead of every row
// showing the same flat gray pill. customer_portal is just --primary
// directly — the portal is this app's own default channel, not one more
// category to color-code.
export const SOURCE_LABEL_KEY: Record<TicketCreationChannel, string> = {
  customer_portal: "sourceCustomer",
  ai: "sourceAi",
  phone: "sourceStaffPhone",
  email: "sourceStaffEmail",
  in_person: "sourceStaffInPerson",
  other: "sourceStaffOther",
};

export const SOURCE_EMOJI: Record<TicketCreationChannel, string> = {
  customer_portal: "🌐",
  ai: "🤖",
  phone: "📞",
  email: "✉️",
  in_person: "🧑‍💼",
  other: "🧩",
};

export const SOURCE_BADGE_CLASS: Record<TicketCreationChannel, string> = {
  customer_portal: "border-transparent bg-primary/10 text-primary",
  ai: "border-transparent bg-channel-ai/10 text-channel-ai",
  phone: "border-transparent bg-channel-phone/10 text-channel-phone",
  email: "border-transparent bg-channel-email/10 text-channel-email",
  in_person: "border-transparent bg-channel-in-person/10 text-channel-in-person",
  other: "border-transparent bg-channel-other/10 text-channel-other",
};

// Reports Story 40's "by source" chart needs each channel's raw hex-backed
// CSS variable (for SVG `fill`, which can't resolve a Tailwind utility
// class) rather than the Tailwind class strings above — same six tokens,
// just referenced as `var(--…)` instead of a `bg-*`/`text-*` class.
export const SOURCE_COLOR_VAR: Record<TicketCreationChannel, string> = {
  customer_portal: "--primary",
  ai: "--channel-ai",
  phone: "--channel-phone",
  email: "--channel-email",
  in_person: "--channel-in-person",
  other: "--channel-other",
};
