"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import type { ReactNode } from "react";

// One client per browser tab, created at module scope (not during render),
// which keeps prerendering deterministic under Cache Components.
const url = process.env.NEXT_PUBLIC_CONVEX_URL;
const client = url ? new ConvexReactClient(url) : null;

/**
 * Connects Convex to Clerk: Convex asks Clerk for a JWT (audience "convex")
 * and validates it server-side, so `ctx.auth` in every Convex function is
 * the verified Clerk user.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  if (!client) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <div className="card">
          <h1 className="text-lg font-semibold">LendLoop is not configured</h1>
          <p className="mt-2 text-sm text-stone-600">
            Set <code>NEXT_PUBLIC_CONVEX_URL</code> in <code>.env.local</code> (run{" "}
            <code>npx convex dev</code>) and restart the dev server. See the README.
          </p>
        </div>
      </main>
    );
  }
  return (
    <ConvexProviderWithClerk client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
