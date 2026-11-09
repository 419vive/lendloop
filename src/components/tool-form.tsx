"use client";

import { useState } from "react";
import { CATEGORIES, CONDITIONS, type Category, type Condition } from "../../convex/lib/validators";
import { CATEGORY_LABELS, CONDITION_LABELS } from "@/lib/format";

export type ToolInput = {
  name: string;
  category: Category;
  condition: Condition;
  description: string;
};

const EMPTY: ToolInput = { name: "", category: "power_tools", condition: "good", description: "" };

export function ToolForm({
  initial = EMPTY,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: ToolInput;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (input: ToolInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const set = <K extends keyof ToolInput>(k: K, v: ToolInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onSubmit(form)) setForm(initial === EMPTY ? EMPTY : form);
      }}
    >
      <label className="sm:col-span-2">
        <span className="label">Name</span>
        <input className="input" required maxLength={80} value={form.name}
          placeholder="e.g. Cordless drill" onChange={(e) => set("name", e.target.value)} />
      </label>
      <label>
        <span className="label">Category</span>
        <select className="input" value={form.category} onChange={(e) => set("category", e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
      </label>
      <label>
        <span className="label">Condition</span>
        <select className="input" value={form.condition} onChange={(e) => set("condition", e.target.value as Condition)}>
          {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
        </select>
      </label>
      <label className="sm:col-span-2">
        <span className="label">Short description</span>
        <textarea className="input" rows={2} maxLength={500} value={form.description}
          placeholder="What's included, any quirks?" onChange={(e) => set("description", e.target.value)} />
      </label>
      {error && <p className="text-sm text-red-700 sm:col-span-2" role="alert">{error}</p>}
      <div className="flex gap-2 sm:col-span-2">
        <button className="btn btn-primary" disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
