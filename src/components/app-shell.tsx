"use client";

import { RedirectToSignIn, UserButton } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";

const NAV = [
  { href: "/browse", label: "All tools" },
  { href: "/listings", label: "My listings" },
  { href: "/requests", label: "My requests" },
  { href: "/incoming", label: "Incoming requests" },
];

/** Upserts the Convex user row once per sign-in (role is decided server-side). */
function useStoreUser() {
  const { isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    store({})
      .then(() => !cancelled && setReady(true))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, store]);
  return { ready, failed };
}

export function AppShell({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { ready, failed } = useStoreUser();
  const me = useQuery(api.users.me, ready ? {} : "skip");
  const pathname = usePathname();
  const nav = me?.role === "admin" ? [...NAV, { href: "/admin", label: "Admin" }] : NAV;

  let body: ReactNode = children;
  if (!isLoading && !isAuthenticated) {
    body = <RedirectToSignIn />;
  } else if (failed) {
    body = (
      <div className="card text-sm text-red-700">
        We couldn&apos;t set up your account. Check that Clerk&apos;s Convex integration is
        configured (see README → Clerk), then reload.
      </div>
    );
  } else if (isLoading || !isAuthenticated || !ready || me === undefined) {
    body = <p className="text-sm text-stone-500">Loading your account…</p>;
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="font-semibold text-brand">
            LendLoop
          </Link>
          <div className="flex items-center gap-3">
            {me?.role === "admin" && <span className="badge bg-amber-100 text-amber-800">Admin</span>}
            {me?.trustedLender && <span className="badge bg-teal-100 text-teal-800">Trusted Lender</span>}
            <UserButton />
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4" aria-label="Main">
          {nav.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
                  active
                    ? "border-brand font-medium text-brand"
                    : "border-transparent text-stone-600 hover:text-stone-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{body}</main>
    </div>
  );
}
