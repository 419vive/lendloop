"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoanList } from "@/components/loan-list";

export default function MyRequestsPage() {
  const loans = useQuery(api.loans.myRequests);
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">My requests</h1>
      <LoanList loans={loans} perspective="borrower" empty="You haven't asked to borrow anything yet." />
    </section>
  );
}
