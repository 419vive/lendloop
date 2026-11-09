"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { LoanList } from "./loan-list";
import { timeAgo } from "@/lib/format";
import { useRun } from "@/lib/use-run";

export function AdminView() {
  const me = useQuery(api.users.me);
  if (me === undefined) return <p className="text-sm text-stone-500">Loading…</p>;
  // The queries below are admin-only on the server too; this is just UX.
  if (me?.role !== "admin") return <p className="card text-sm">Admins only.</p>;
  return <AdminPanels />;
}

function AdminPanels() {
  const users = useQuery(api.admin.listUsers);
  const loans = useQuery(api.loans.allLoans);
  const health = useQuery(api.admin.automationHealth);
  const setTrusted = useMutation(api.admin.setTrustedLender);
  const { run, pending, error } = useRun();

  return (
    <section className="space-y-8">
      <div>
        <h1 className="mb-3 text-xl font-semibold">Automation health</h1>
        {health === undefined ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : (
          <div className="card space-y-3 text-sm">
            <p>
              Recent notifications: {health.counts.delivered} delivered · {health.counts.pending} pending ·{" "}
              <span className={health.counts.failed ? "font-semibold text-red-700" : ""}>{health.counts.failed} failed</span> ·{" "}
              {health.counts.skipped} skipped
            </p>
            {health.failedDeliveries.length > 0 && (
              <ul className="list-disc pl-5 text-red-700">
                {health.failedDeliveries.map((f) => (
                  <li key={f._id}>{f.event}: {f.lastError} ({f.attempts} attempts, {timeAgo(f.updatedAt)})</li>
                ))}
              </ul>
            )}
            <div>
              <p className="font-medium">n8n workflow errors</p>
              {health.workflowErrors.length === 0 ? (
                <p className="text-stone-500">None reported.</p>
              ) : (
                <ul className="list-disc pl-5">
                  {health.workflowErrors.map((e) => (
                    <li key={e._id}>
                      <span className="font-medium">{e.workflowName}</span>
                      {e.nodeName ? ` › ${e.nodeName}` : ""}: {e.message}{" "}
                      <span className="text-stone-500">({timeAgo(e.occurredAt)}{e.executionId ? `, execution ${e.executionId}` : ""})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Members</h2>
        {error && <p className="mb-2 text-sm text-red-700" role="alert">{error}</p>}
        {users === undefined ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-stone-200 text-xs uppercase text-stone-500">
                <tr><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Role</th><th className="p-3">Listings</th><th className="p-3">Trusted Lender</th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u._id} className="border-b border-stone-100 last:border-0">
                    <td className="p-3">{u.name}</td>
                    <td className="p-3 text-stone-600">{u.email ?? "—"}</td>
                    <td className="p-3 capitalize">{u.role}</td>
                    <td className="p-3">{u.listings}</td>
                    <td className="p-3">
                      <label className="inline-flex items-center gap-2">
                        <input type="checkbox" checked={u.trustedLender} disabled={pending}
                          onChange={(e) => run(() => setTrusted({ userId: u._id, trusted: e.target.checked }))} />
                        {u.trustedLender ? "Trusted" : "—"}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">All loans</h2>
        <LoanList loans={loans} perspective="admin" empty="No loans yet." />
      </div>
    </section>
  );
}
