"use client";

import { useEffect } from "react";
import { io } from "socket.io-client";
import { useRouter } from "next/navigation";
import { API_URL } from "@/lib/auth";

const REFRESH_DEBOUNCE_MS = 400;

// Wakes the ticket list/queue and ticket-detail pages the moment anyone
// changes a ticket, instead of leaving them to a manual reload — see
// backend/src/services/ticketRealtime.service.ts for what gets broadcast
// and why. Connection lifecycle mirrors StaffNotificationSocket.tsx (auth
// via the handshake token, give up on the first "Unauthorized" rather than
// retrying forever with a now-stale one), but reacts by refreshing the
// current route instead of toasting — the same router.refresh() pattern
// ReassignAgentMenu.tsx and the theme/locale toggles already use, just
// triggered by a push instead of a click. Mount with no `ticketId` on a
// list/queue page; pass the ticket's id on its detail page to also join
// that ticket's own room.
export function TicketLiveRefresh({ token, ticketId }: { token: string; ticketId?: string }) {
  const router = useRouter();

  useEffect(() => {
    let gaveUp = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    // Several changes can land within milliseconds of each other (e.g. a
    // reply that also flips status to "answered" broadcasts twice) —
    // debounced so that lands as one refresh, not a visible flicker per
    // event.
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    }

    const socket = io(API_URL, {
      auth: { token },
      transports: ["websocket"],
      reconnectionAttempts: 3,
    });

    if (ticketId) {
      socket.on("connect", () => socket.emit("ticket:join", ticketId));
      socket.on("ticket:updated", (payload: { ticketId: string }) => {
        if (payload.ticketId === ticketId) scheduleRefresh();
      });
    }
    // Always listens, list page or detail page alike — this is what makes
    // the ticket list/queue live; on the detail page it's a harmless extra
    // refresh (e.g. a different ticket's status changed), never a wrong one.
    socket.on("tickets:changed", () => scheduleRefresh());

    socket.on("connect_error", (err) => {
      console.error("[TicketLiveRefresh] connect error:", err.message);
      if (err.message === "Unauthorized" && !gaveUp) {
        gaveUp = true;
        socket.disconnect();
      }
    });

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (ticketId) socket.emit("ticket:leave", ticketId);
      socket.disconnect();
    };
  }, [token, ticketId, router]);

  return null;
}
