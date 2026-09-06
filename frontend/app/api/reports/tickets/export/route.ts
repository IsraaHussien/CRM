import { NextRequest } from "next/server";
import { proxyCustomerFile } from "@/lib/customerFileProxy";

// reports-management Story 40: same reasoning as
// app/api/tickets/[id]/history/export/route.ts — the bearer token lives only
// in an httpOnly cookie, so the CSV export link can't hit the backend
// directly; this Route Handler reads the cookie server-side and streams the
// backend's response through.
export async function GET(request: NextRequest) {
  const query = request.nextUrl.search;
  return proxyCustomerFile(`/api/v1/reports/tickets/export.csv${query}`);
}
