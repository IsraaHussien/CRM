import { redirect } from "next/navigation";

// The shell (layout.tsx) has no content of its own — landing on the bare
// root redirects to the first tab, same pattern as
// system-configuration/page.tsx.
export default function ReportsIndexRedirect() {
  redirect("/admin/reports/tickets");
}
