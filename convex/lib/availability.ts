import type { Doc, Id } from "../_generated/dataModel";
import type { Ctx } from "./auth";

export type Availability =
  | { state: "available"; bookings: Booking[] }
  | { state: "on_loan"; until: string; overdue: boolean; bookings: Booking[] };

export type Booking = { startDate: string; endDate: string };

/** Approved loans that have not been returned yet (current + upcoming). */
export async function activeLoansForTool(
  ctx: Ctx,
  toolId: Id<"tools">,
): Promise<Doc<"loans">[]> {
  return await ctx.db
    .query("loans")
    .withIndex("by_tool_status", (q) => q.eq("toolId", toolId).eq("status", "approved"))
    .collect();
}

export async function availabilityFor(
  ctx: Ctx,
  toolId: Id<"tools">,
  today: string,
): Promise<Availability> {
  const active = await activeLoansForTool(ctx, toolId);
  const bookings = active
    .map((l) => ({ startDate: l.startDate, endDate: l.endDate }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  // "On loan" = an approved loan has started and is not returned. A loan past
  // its end date stays "on loan" (and overdue) until the lender marks it returned.
  const current = active.find((l) => l.startDate <= today);
  if (current) {
    return {
      state: "on_loan",
      until: current.endDate,
      overdue: current.endDate < today,
      bookings,
    };
  }
  return { state: "available", bookings };
}
