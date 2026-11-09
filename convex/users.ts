import { mutation, query } from "./_generated/server";
import { getCurrentUser, isAdminEmail } from "./lib/auth";

/**
 * Upsert the caller's user row from their verified Clerk identity.
 * Called by the client once per sign-in. The role is recomputed every time
 * from the ADMIN_EMAILS deployment env var, so removing someone from that
 * list demotes them on their next sign-in. The client cannot pass a role.
 */
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Called users.store without authentication");

    const name = (identity.name ?? identity.givenName ?? identity.nickname ?? "Neighbour")
      .trim()
      .slice(0, 80);
    // Only trust an email Clerk says is verified for admin promotion.
    const email = identity.email && identity.emailVerified !== false ? identity.email : undefined;
    const role = isAdminEmail(email) ? ("admin" as const) : ("user" as const);

    const existing = await getCurrentUser(ctx);
    if (existing) {
      if (existing.name !== name || existing.email !== email || existing.role !== role) {
        await ctx.db.patch("users", existing._id, { name, email, role });
      }
      return existing._id;
    }
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name,
      email,
      role,
      trustedLender: false,
    });
  },
});

/** The caller's own profile (the only place a user's email is returned). */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name,
      email: user.email ?? null,
      role: user.role,
      trustedLender: user.trustedLender,
    };
  },
});
