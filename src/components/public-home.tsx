"use client";

import { SignInButton } from "@clerk/nextjs";
import { Authenticated, AuthLoading, Unauthenticated, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Category } from "../../convex/lib/validators";
import { CategoryFilter } from "./category-filter";
import { CATEGORY_LABELS } from "@/lib/format";

export function PublicHome() {
  const [category, setCategory] = useState<Category | undefined>();
  const tools = useQuery(api.tools.listPublic, { category });

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <header className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-brand">LendLoop</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
          Borrow what you need.
          <br />
          Lend what you don&apos;t.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-stone-600">
          A tool library run by your neighbours. List the drill that sits in your
          garage, borrow the tent you need once a year.
        </p>
        <div className="mt-6 flex justify-center">
          <AuthLoading>
            <span className="btn" aria-busy>Loading…</span>
          </AuthLoading>
          <Unauthenticated>
            <SignInButton mode="modal" forceRedirectUrl="/browse">
              <button className="btn btn-primary px-5 py-2 text-base">Sign in to lend or borrow</button>
            </SignInButton>
          </Unauthenticated>
          <Authenticated>
            <Link href="/browse" className="btn btn-primary px-5 py-2 text-base">
              Open LendLoop →
            </Link>
          </Authenticated>
        </div>
      </header>

      <section className="mt-12">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Tools in the library</h2>
          <CategoryFilter value={category} onChange={setCategory} />
        </div>
        {tools === undefined ? (
          <p className="text-sm text-stone-500">Loading tools…</p>
        ) : tools.length === 0 ? (
          <p className="card text-sm text-stone-500">No tools listed yet. Be the first!</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tools.map((t) => (
              <li key={t._id} className="card">
                <p className="font-medium">{t.name}</p>
                <p className="mt-1 text-sm text-stone-500">{CATEGORY_LABELS[t.category]}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
