"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updateTicketStatus } from "./actions";

interface ReopenTicketButtonProps {
  ticketId: string;
}

// customer-portal Story 37: the one status transition a customer can
// trigger themselves (closed -> in_progress). Reuses updateTicketStatus
// (actions.ts:78-111) as-is — same PATCH /:id/status endpoint the staff
// status select already calls, just a fixed target status instead of a
// picker. Same useTransition + inline message pattern as
// TicketDetailSidebar's handleStatusChange.
export function ReopenTicketButton({ ticketId }: ReopenTicketButtonProps) {
  const t = useTranslations("TicketDetail");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleReopen() {
    setError(null);
    startTransition(async () => {
      const result = await updateTicketStatus(ticketId, "in_progress");
      if (result.error) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-muted/40 p-3">
      <p className="text-sm text-muted-foreground">{t("reopenPrompt")}</p>
      <Button variant="outline" size="sm" onClick={handleReopen} disabled={pending}>
        <RotateCcw className="size-3.5" />
        {pending ? t("reopenPending") : t("reopenTicket")}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
