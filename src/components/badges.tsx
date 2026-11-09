import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { formatDate, formatRange, timeAgo } from "@/lib/format";

type Availability = FunctionReturnType<typeof api.tools.listAll>[number]["availability"];
export type LoanView = FunctionReturnType<typeof api.loans.myRequests>[number];
type Activity = LoanView["activity"][number];

export function AvailabilityBadge({ availability }: { availability: Availability }) {
  if (availability.state === "available") {
    return <span className="badge bg-emerald-100 text-emerald-800">Available</span>;
  }
  if (availability.overdue) {
    return <span className="badge bg-red-100 text-red-800">Overdue since {formatDate(availability.until)}</span>;
  }
  return <span className="badge bg-amber-100 text-amber-800">On loan until {formatDate(availability.until)}</span>;
}

export function Bookings({ availability }: { availability: Availability }) {
  if (availability.bookings.length === 0) return null;
  return (
    <p className="text-xs text-stone-500">
      Booked: {availability.bookings.map((b) => formatRange(b.startDate, b.endDate)).join(", ")}
    </p>
  );
}

const STATUS_STYLE: Record<LoanView["status"], string> = {
  pending: "bg-sky-100 text-sky-800",
  approved: "bg-emerald-100 text-emerald-800",
  declined: "bg-stone-200 text-stone-700",
  cancelled: "bg-stone-200 text-stone-700",
  returned: "bg-stone-100 text-stone-600",
};

export function StatusBadge({ loan }: { loan: Pick<LoanView, "status" | "overdue"> }) {
  if (loan.overdue) return <span className="badge bg-red-100 text-red-800">Overdue</span>;
  return <span className={`badge capitalize ${STATUS_STYLE[loan.status]}`}>{loan.status}</span>;
}

export function TrustedBadge() {
  return (
    <span className="badge bg-teal-100 text-teal-800" title="Verified by a LendLoop admin">
      ✓ Trusted Lender
    </span>
  );
}

function describe(a: Activity): string {
  const when = timeAgo(a.updatedAt);
  if (a.kind === "overdue_reminder") {
    return a.status === "delivered" ? `Reminder sent ${when}` : `Reminder failed ${when}`;
  }
  const who = a.event === "request.created" || a.event === "request.cancelled" ? "Lender" : "Borrower";
  switch (a.status) {
    case "delivered":
      return `${who} notified ${when}`;
    case "pending":
      return a.attempts > 0 ? `Notification retrying (attempt ${a.attempts + 1})` : "Notification queued";
    case "failed":
      return `Notification failed after ${a.attempts} attempts`;
    case "skipped":
      return "Notifications not configured";
  }
}

/** "Reminder sent 2 days ago" — the latest automation activity for a loan. */
export function ActivityLine({ activity }: { activity: Activity[] }) {
  if (activity.length === 0) return null;
  const [latest, ...rest] = activity;
  const failed = latest.status === "failed";
  return (
    <p className={`text-xs ${failed ? "text-red-700" : "text-stone-500"}`} title={rest.map(describe).join("\n")}>
      ⚙ {describe(latest)}
      {rest.length > 0 && <span className="text-stone-400"> · {rest.length} earlier</span>}
    </p>
  );
}
