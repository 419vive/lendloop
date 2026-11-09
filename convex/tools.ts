import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { availabilityFor, activeLoansForTool } from "./lib/availability";
import {
  badRequest,
  forbidden,
  getCurrentUser,
  notFound,
  publicName,
  requireUser,
  type Ctx,
} from "./lib/auth";
import { toIsoDate } from "./lib/dates";
import { enqueueNotification } from "./notifications";
import { categoryValidator, conditionValidator, LIMITS } from "./lib/validators";

function cleanText(value: string, field: string, max: number, required = true): string {
  const trimmed = value.trim();
  if (required && trimmed.length === 0) badRequest(`${field} is required`);
  if (trimmed.length > max) badRequest(`${field} must be at most ${max} characters`);
  return trimmed;
}

async function listByCategory(ctx: Ctx, category: Doc<"tools">["category"] | undefined) {
  return category
    ? await ctx.db
        .query("tools")
        .withIndex("by_category", (q) => q.eq("category", category))
        .order("desc")
        .collect()
    : await ctx.db.query("tools").order("desc").collect();
}

/**
 * Public, unauthenticated catalogue. Returns ONLY name + category; no
 * owner, condition, description or availability ever leaves this query.
 */
export const listPublic = query({
  args: { category: v.optional(categoryValidator) },
  handler: async (ctx, { category }) => {
    const tools = await listByCategory(ctx, category);
    return tools.slice(0, 200).map((t) => ({ _id: t._id, name: t.name, category: t.category }));
  },
});

/** Signed-in catalogue with availability. Owners are shown by first name only. */
export const listAll = query({
  args: { category: v.optional(categoryValidator) },
  handler: async (ctx, { category }) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const today = toIsoDate(Date.now());
    const tools = await listByCategory(ctx, category);
    return await Promise.all(
      tools.map(async (t) => {
        const owner = await ctx.db.get("users", t.ownerId);
        return {
          _id: t._id,
          _creationTime: t._creationTime,
          name: t.name,
          category: t.category,
          condition: t.condition,
          description: t.description,
          ownerName: publicName(owner),
          ownerTrusted: owner?.trustedLender ?? false,
          isMine: t.ownerId === me._id,
          availability: await availabilityFor(ctx, t._id, today),
        };
      }),
    );
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const today = toIsoDate(Date.now());
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", me._id))
      .order("desc")
      .collect();
    return await Promise.all(
      tools.map(async (t) => {
        const pending = await ctx.db
          .query("loans")
          .withIndex("by_tool_status", (q) => q.eq("toolId", t._id).eq("status", "pending"))
          .collect();
        return {
          ...t,
          pendingRequests: pending.length,
          availability: await availabilityFor(ctx, t._id, today),
        };
      }),
    );
  },
});

const toolFields = {
  name: v.string(),
  category: categoryValidator,
  condition: conditionValidator,
  description: v.string(),
};

export const create = mutation({
  args: toolFields,
  handler: async (ctx, args) => {
    const me = await requireUser(ctx);
    return await ctx.db.insert("tools", {
      ownerId: me._id,
      name: cleanText(args.name, "Name", LIMITS.nameMax),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, "Description", LIMITS.descriptionMax, false),
    });
  },
});

/** Only the owner may edit. Admins moderate by removing, not by editing. */
export const update = mutation({
  args: { toolId: v.id("tools"), ...toolFields },
  handler: async (ctx, { toolId, ...args }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    if (!tool) notFound("Listing not found");
    if (tool.ownerId !== me._id) forbidden("You can only edit your own listings");
    await ctx.db.patch("tools", toolId, {
      name: cleanText(args.name, "Name", LIMITS.nameMax),
      category: args.category,
      condition: args.condition,
      description: cleanText(args.description, "Description", LIMITS.descriptionMax, false),
    });
  },
});

/**
 * Owners can delete their own listing; admins can remove any listing.
 * A listing that is currently lent out (or booked) cannot be removed by its
 * owner, because that would orphan a loan the borrower is relying on.
 * Pending requests are cancelled and the borrowers notified.
 */
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    if (!tool) notFound("Listing not found");
    const isOwner = tool.ownerId === me._id;
    const isAdmin = me.role === "admin";
    if (!isOwner && !isAdmin) forbidden("You can only delete your own listings");

    const active = await activeLoansForTool(ctx, toolId);
    if (active.length > 0 && !isAdmin) {
      badRequest("This tool has approved loans. Mark them returned before deleting it.");
    }

    const open = await ctx.db
      .query("loans")
      .withIndex("by_tool_status", (q) => q.eq("toolId", toolId).eq("status", "pending"))
      .collect();
    for (const loan of [...open, ...active]) {
      await ctx.db.patch("loans", loan._id, { status: "cancelled", decidedAt: Date.now() });
      await enqueueNotification(ctx, loan._id, "request.cancelled_listing_removed");
    }
    await ctx.db.delete("tools", toolId);
  },
});
