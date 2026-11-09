"use client";

import { CATEGORIES, type Category } from "../../convex/lib/validators";
import { CATEGORY_LABELS } from "@/lib/format";

export function CategoryFilter({
  value,
  onChange,
}: {
  value: Category | undefined;
  onChange: (c: Category | undefined) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-stone-500">Category</span>
      <select
        className="input w-auto"
        value={value ?? ""}
        onChange={(e) => onChange((e.target.value || undefined) as Category | undefined)}
      >
        <option value="">All</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
    </label>
  );
}
