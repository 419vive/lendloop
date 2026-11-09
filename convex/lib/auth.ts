import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Authorization helpers. Every public query/mutation that touches private
 * data goes through one of these, so RBAC is enforced on the server no
 * matter what the UI shows or hides.
 */

export type Ctx = QueryCtx | MutationCtx;

export function forbidden(message = "You are not allowed to do that"): never {
  throw new ConvexError({ code: "FORBIDDEN", message });
}

export function badRequest(message: string): never {
  throw new ConvexError({ code: "BAD_REQUEST", message });
}

export function notFound(message = "Not found"): never {
  throw new ConvexError({ code: "NOT_FOUND", message });
}

/** Returns the caller's user row, or null when signed out / not yet synced. */
export async function getCurrentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first" });
  }
  const user = await getCurrentUser(ctx);
  if (!user) {
    // The client calls users.store right after sign-in; this only happens in
    // the brief window before that completes.
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Account not ready yet" });
  }
  return user;
}

export async function requireAdmin(ctx: Ctx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.role !== "admin") forbidden("Admins only");
  return user;
}

/** Admin emails come from the deployment env, never from client input. */
export function isAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/** Data minimisation: other users only ever see a first name. */
export function publicName(user: Pick<Doc<"users">, "name"> | null): string {
  if (!user) return "Unknown";
  return user.name.trim().split(/\s+/)[0] || "Neighbour";
}
