import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { notFound, requireAdmin } from "./lib/auth";

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").take(500);
    return await Promise.all(
      users.map(async (u) => {
        const tools = await ctx.db
          .query("tools")
          .withIndex("by_owner", (q) => q.eq("ownerId", u._id))
          .collect();
        return {
          _id: u._id,
          name: u.name,
          email: u.email ?? null,
          role: u.role,
          trustedLender: u.trustedLender,
          listings: tools.length,
        };
      }),
    );
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get("users", userId);
    if (!user) notFound("User not found");
    await ctx.db.patch("users", userId, { trustedLender: trusted });
  },
});

/** Failures reported by the n8n error workflow, plus failed outbound webhooks. */
export const automationHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const workflowErrors = await ctx.db.query("workflowErrors").order("desc").take(20);
    const recent = await ctx.db.query("automationEvents").order("desc").take(200);
    return {
      workflowErrors: workflowErrors.map((e) => ({
        _id: e._id,
        workflowName: e.workflowName,
        nodeName: e.nodeName ?? null,
        message: e.message,
        executionId: e.executionId ?? null,
        occurredAt: e.occurredAt,
      })),
      failedDeliveries: recent
        .filter((e) => e.status === "failed")
        .slice(0, 20)
        .map((e) => ({
          _id: e._id,
          loanId: e.loanId,
          event: e.event ?? e.kind,
          attempts: e.attempts,
          lastError: e.lastError ?? null,
          updatedAt: e.updatedAt,
        })),
      counts: {
        delivered: recent.filter((e) => e.status === "delivered").length,
        pending: recent.filter((e) => e.status === "pending").length,
        failed: recent.filter((e) => e.status === "failed").length,
        skipped: recent.filter((e) => e.status === "skipped").length,
      },
    };
  },
});
