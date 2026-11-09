"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AvailabilityBadge, Bookings } from "./badges";
import { ToolForm } from "./tool-form";
import { CATEGORY_LABELS, CONDITION_LABELS } from "@/lib/format";
import { useRun } from "@/lib/use-run";

export function ListingsView() {
  const tools = useQuery(api.tools.listMine);
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const remove = useMutation(api.tools.remove);
  const createState = useRun();
  const editState = useRun();
  const removeState = useRun();
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);

  return (
    <section className="space-y-6">
      <div className="card">
        <h1 className="mb-3 text-xl font-semibold">List a tool</h1>
        <ToolForm
          submitLabel="Add listing"
          pending={createState.pending}
          error={createState.error}
          onSubmit={async (input) => Boolean(await createState.run(() => create(input)))}
        />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">My listings</h2>
        {removeState.error && <p className="mb-3 text-sm text-red-700" role="alert">{removeState.error}</p>}
        {tools === undefined ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="card text-sm text-stone-500">You haven&apos;t listed anything yet.</p>
        ) : (
          <ul className="space-y-3">
            {tools.map((t) => (
              <li key={t._id} className="card">
                {editing === t._id ? (
                  <ToolForm
                    initial={{ name: t.name, category: t.category, condition: t.condition, description: t.description }}
                    submitLabel="Save changes"
                    pending={editState.pending}
                    error={editState.error}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      const ok = await editState.run(async () => {
                        await update({ toolId: t._id, ...input });
                        return true;
                      });
                      if (ok) setEditing(null);
                      return Boolean(ok);
                    }}
                  />
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="font-medium">{t.name}</p>
                      <p className="text-sm text-stone-500">
                        {CATEGORY_LABELS[t.category]} · {CONDITION_LABELS[t.condition]}
                      </p>
                      {t.description && <p className="text-sm text-stone-700">{t.description}</p>}
                      <Bookings availability={t.availability} />
                      {t.pendingRequests > 0 && (
                        <Link href="/incoming" className="text-sm font-medium text-brand underline">
                          {t.pendingRequests} pending request{t.pendingRequests > 1 ? "s" : ""}
                        </Link>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <AvailabilityBadge availability={t.availability} />
                      <div className="flex gap-2">
                        <button className="btn" onClick={() => { editState.clearError(); setEditing(t._id); }}>Edit</button>
                        <button
                          className="btn btn-danger"
                          disabled={removeState.pending}
                          onClick={() => {
                            if (confirm(`Delete "${t.name}"? Pending requests will be cancelled.`)) {
                              void removeState.run(() => remove({ toolId: t._id }));
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
