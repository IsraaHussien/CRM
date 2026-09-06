import { Fragment } from "react";
import { getTranslations } from "next-intl/server";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

type CustomerFacingStatus = "new" | "in_progress" | "answered" | "escalated" | "closed";

const STAGE_KEYS = [
  "progressStageReceived",
  "progressStageInProgress",
  "progressStageAnswered",
  "progressStageResolved",
] as const;

// "escalated" is deliberately folded into the same stage as "in_progress" —
// escalation is internal routing to a senior agent/admin, not something the
// customer needs to track (staff still see the real status elsewhere, e.g.
// TicketDetailSidebar's status select and "Escalated to" field).
function stageIndexForStatus(status: CustomerFacingStatus): number {
  switch (status) {
    case "new":
      return 0;
    case "in_progress":
    case "escalated":
      return 1;
    case "answered":
      return 2;
    case "closed":
      return 3;
  }
}

// customer-portal Story 36 follow-up: replaces the old bare status Badge on
// the customer's own ticket-detail view with a 4-stage progress stepper,
// plus a one-line "engagement" indicator. The engagement line is driven
// independently of the stepper stage — it only ever reads whether
// `assignedAgent` is set, never who it is, so a customer knows someone's on
// it without the app naming or ranking that person.
export async function CustomerTicketProgress({
  status,
  hasAssignedAgent,
}: {
  status: CustomerFacingStatus;
  hasAssignedAgent: boolean;
}) {
  const t = await getTranslations("TicketDetail");
  const currentStage = stageIndexForStatus(status);

  const engagementKey =
    status === "closed"
      ? "progressEngagementResolved"
      : status === "answered"
        ? "progressEngagementAnswered"
        : hasAssignedAgent
          ? "progressEngagementWorking"
          : "progressEngagementWaiting";

  const engagementToneClass =
    status === "closed"
      ? "bg-success/10 text-success"
      : status === "answered" || hasAssignedAgent
        ? "bg-accent text-accent-foreground"
        : "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col gap-2.5 border-b border-border pb-4">
      <div className="flex items-center">
        {STAGE_KEYS.map((key, index) => (
          <Fragment key={key}>
            <span
              className={cn(
                "flex size-[18px] shrink-0 items-center justify-center rounded-full border-2",
                index < currentStage
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card"
              )}
            >
              {index < currentStage ? (
                <Check className="size-2.5" strokeWidth={3} />
              ) : index === currentStage ? (
                <span className="size-2 rounded-full bg-primary" />
              ) : null}
            </span>
            {index < STAGE_KEYS.length - 1 && (
              <span className={cn("mx-1.5 h-0.5 flex-1", index < currentStage ? "bg-primary" : "bg-border")} />
            )}
          </Fragment>
        ))}
      </div>
      <div className="grid grid-cols-4 text-xs font-medium">
        {STAGE_KEYS.map((key, index) => (
          <span
            key={key}
            className={cn(
              index === 0 && "text-start",
              index === STAGE_KEYS.length - 1 && "text-end",
              index !== 0 && index !== STAGE_KEYS.length - 1 && "text-center",
              index === currentStage ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {t(key)}
          </span>
        ))}
      </div>
      <div className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium", engagementToneClass)}>
        <span className="size-1.5 shrink-0 rounded-full bg-current" />
        {t(engagementKey)}
      </div>
    </div>
  );
}
