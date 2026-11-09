"use client";

import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ActivityLine, StatusBadge, TrustedBadge, type LoanView } from "./badges";
import { formatRange } from "@/lib/format";
import { useRun } from "@/lib/use-run";

type Perspective = "borrower" | "lender" | "admin";

function LoanActions({ loan, perspective }: { loan: LoanView; perspective: Perspective }) {
  const approve = useMutation(api.loans.approve);
  const decline = useMutation(api.loans.decline);
  const cancel = useMutation(api.loans.cancel);
  const markReturned = useMutation(api.loans.markReturned);
  const { run, pending, error } = useRun();
  const args = { loanId: loan._id };

  let buttons = null;
  if (perspective === "lender" && loan.status === "pending") {
    buttons = (
      <>
        <button className="btn btn-primary" disabled={pending} onClick={() => run(() => approve(args))}>Approve</button>
        <button className="btn" disabled={pending} onClick={() => run(() => decline(args))}>Decline</button>
      </>
    );
  } else if (perspective === "lender" && loan.status === "approved") {
    buttons = (
      <button className="btn" disabled={pending} onClick={() => run(() => markReturned(args))}>Mark returned</button>
    );
  } else if (perspective === "borrower" && loan.status === "pending") {
    buttons = (
      <button className="btn" disabled={pending} onClick={() => run(() => cancel(args))}>Cancel request</button>
    );
  }
  if (!buttons && !error) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">{buttons}</div>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
    </div>
  );
}

export function LoanList({
  loans,
  perspective,
  empty,
}: {
  loans: (LoanView & { lenderEmail?: string | null; borrowerEmail?: string | null })[] | undefined;
  perspective: Perspective;
  empty: string;
}) {
  if (loans === undefined) return <p className="text-sm text-stone-500">Loading…</p>;
  if (loans.length === 0) return <p className="card text-sm text-stone-500">{empty}</p>;
  return (
    <ul className="space-y-3">
      {loans.map((loan) => (
        <li key={loan._id} className="card flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{loan.toolName}</p>
              <StatusBadge loan={loan} />
            </div>
            <p className="text-sm text-stone-600">{formatRange(loan.startDate, loan.endDate)}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
              {perspective !== "borrower" && <span>Borrower: {loan.borrowerName}{loan.borrowerEmail ? ` (${loan.borrowerEmail})` : ""}</span>}
              {perspective !== "lender" && <span>Lender: {loan.lenderName}{loan.lenderEmail ? ` (${loan.lenderEmail})` : ""}</span>}
              {perspective !== "lender" && loan.lenderTrusted && <TrustedBadge />}
            </p>
            {loan.message && <p className="text-sm italic text-stone-600">“{loan.message}”</p>}
            <ActivityLine activity={loan.activity} />
          </div>
          {perspective !== "admin" && <LoanActions loan={loan} perspective={perspective} />}
        </li>
      ))}
    </ul>
  );
}
