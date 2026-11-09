"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Category } from "../../convex/lib/validators";
import { AvailabilityBadge, Bookings, TrustedBadge } from "./badges";
import { BorrowForm } from "./borrow-form";
import { CategoryFilter } from "./category-filter";
import { CATEGORY_LABELS, CONDITION_LABELS } from "@/lib/format";
import { useRun } from "@/lib/use-run";

export function BrowseView() {
  const [category, setCategory] = useState<Category | undefined>();
  const [borrowing, setBorrowing] = useState<Id<"tools"> | null>(null);
  const tools = useQuery(api.tools.listAll, { category });
  const me = useQuery(api.users.me);
  const remove = useMutation(api.tools.remove);
  const { run, error } = useRun();

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">All tools</h1>
        <CategoryFilter value={category} onChange={setCategory} />
      </div>
      {error && <p className="mb-3 text-sm text-red-700" role="alert">{error}</p>}
      {tools === undefined ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : tools.length === 0 ? (
        <p className="card text-sm text-stone-500">No tools in this category yet.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {tools.map((t) => (
            <li key={t._id} className="card flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-sm text-stone-500">
                    {CATEGORY_LABELS[t.category]} · {CONDITION_LABELS[t.condition]}
                  </p>
                </div>
                <AvailabilityBadge availability={t.availability} />
              </div>
              {t.description && <p className="text-sm text-stone-700">{t.description}</p>}
              <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                <span>Lent by {t.isMine ? "you" : t.ownerName}</span>
                {t.ownerTrusted && <TrustedBadge />}
              </div>
              <Bookings availability={t.availability} />
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                {!t.isMine && borrowing !== t._id && (
                  <button className="btn btn-primary" onClick={() => setBorrowing(t._id)}>
                    Request to borrow
                  </button>
                )}
                {me?.role === "admin" && !t.isMine && (
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      if (confirm(`Remove "${t.name}" for everyone? Open requests will be cancelled.`)) {
                        void run(() => remove({ toolId: t._id }));
                      }
                    }}
                  >
                    Remove listing
                  </button>
                )}
              </div>
              {borrowing === t._id && <BorrowForm toolId={t._id} onDone={() => setBorrowing(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
