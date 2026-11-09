import { internalMutation } from "./_generated/server";
import { addDays, toIsoDate } from "./lib/dates";

/**
 * Demo data for local development: `npx convex run seed:demo`.
 * Internal-only (not callable from the browser). Creates two demo neighbours,
 * a few listings and one overdue loan so the n8n overdue workflow has
 * something to remind about. Safe to run twice: it no-ops if seeded.
 */
export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const already = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", "seed|alice"))
      .unique();
    if (already) return { seeded: false, reason: "already seeded" };

    const alice = await ctx.db.insert("users", {
      tokenIdentifier: "seed|alice",
      name: "Alice Lender",
      email: "alice@example.com",
      role: "user",
      trustedLender: true,
    });
    const bob = await ctx.db.insert("users", {
      tokenIdentifier: "seed|bob",
      name: "Bob Borrower",
      email: "bob@example.com",
      role: "user",
      trustedLender: false,
    });

    const drill = await ctx.db.insert("tools", {
      ownerId: alice,
      name: "Cordless drill (18V)",
      category: "power_tools",
      condition: "good",
      description: "Two batteries and a charger. Bits not included.",
    });
    await ctx.db.insert("tools", {
      ownerId: alice,
      name: "Hedge trimmer",
      category: "garden",
      condition: "fair",
      description: "Electric, 10 m cable.",
    });
    await ctx.db.insert("tools", {
      ownerId: bob,
      name: "4-person tent",
      category: "camping",
      condition: "new",
      description: "Used once. Pegs and footprint included.",
    });
    await ctx.db.insert("tools", {
      ownerId: bob,
      name: "Stand mixer",
      category: "kitchen",
      condition: "good",
      description: "With dough hook and whisk.",
    });

    const today = toIsoDate(Date.now());
    const overdueLoan = await ctx.db.insert("loans", {
      toolId: drill,
      ownerId: alice,
      borrowerId: bob,
      toolName: "Cordless drill (18V)",
      startDate: addDays(today, -7),
      endDate: addDays(today, -2),
      status: "approved",
      decidedAt: Date.now() - 7 * 86_400_000,
    });
    return { seeded: true, overdueLoan };
  },
});
