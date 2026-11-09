"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { todayIso } from "@/lib/format";
import { useRun } from "@/lib/use-run";

export function BorrowForm({ toolId, onDone }: { toolId: Id<"tools">; onDone: () => void }) {
  const request = useMutation(api.loans.request);
  const { run, pending, error } = useRun();
  const today = todayIso();
  const [startDate, setStart] = useState(today);
  const [endDate, setEnd] = useState(today);
  const [message, setMessage] = useState("");

  return (
    <form
      className="mt-3 space-y-2 rounded-lg bg-stone-50 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const id = await run(() => request({ toolId, startDate, endDate, message: message || undefined }));
        if (id) onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="label">From</span>
          <input className="input" type="date" min={today} value={startDate} required
            onChange={(e) => { setStart(e.target.value); if (e.target.value > endDate) setEnd(e.target.value); }} />
        </label>
        <label>
          <span className="label">Until</span>
          <input className="input" type="date" min={startDate} value={endDate} required
            onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="block">
        <span className="label">Note to lender (optional)</span>
        <input className="input" maxLength={300} value={message} placeholder="What's it for?"
          onChange={(e) => setMessage(e.target.value)} />
      </label>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={pending}>{pending ? "Sending…" : "Send request"}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
