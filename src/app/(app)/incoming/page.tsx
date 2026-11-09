"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoanList } from "@/components/loan-list";

export default function IncomingRequestsPage() {
  const loans = useQuery(api.loans.incoming);
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Incoming requests</h1>
      <LoanList loans={loans} perspective="lender" empty="Nobody has asked to borrow your tools yet." />
    </section>
  );
}
