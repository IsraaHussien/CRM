import { getIoInstance } from "../sockets/ioRegistry";

// Ticket real-time sync: every mutation broadcasts to (a) the ticket's own
// room, for whoever has its detail page open (customer or staff — see
// chat.socket.ts's "ticket:join" handler for who's allowed to join), and
// (b) the shared staff room plus the ticket's customer's personal room
// (already joined by every authenticated socket, see chat.socket.ts's
// connection handler), for whoever has a ticket list open that might
// include this ticket. Every listener just calls router.refresh() rather
// than trusting a partial payload here — same "never trust client-side
// filtering, re-derive server-side" rule GET /tickets already follows for
// reads, now extended to the push side. customerId is optional: an
// internal note (never customer-visible) has no reason to wake the
// customer's own list.
export function emitTicketUpdated(ticketId: string, customerId?: string): void {
  const io = getIoInstance();
  if (!io) return;
  io.to(`ticket:${ticketId}`).emit("ticket:updated", { ticketId });
  io.to("staff:tickets").emit("tickets:changed", { ticketId });
  if (customerId) {
    io.to(`user:${customerId}`).emit("tickets:changed", { ticketId });
  }
}
