import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  badRequest,
  forbidden,
  getCurrentUser,
  notFound,
  publicName,
  requireAdmin,
  requireUser,
  type Ctx,
} from "./lib/auth";
import { addDays, daysBetween, isIsoDate, rangesOverlap, toIsoDate } from "./lib/dates";
import { LIMITS } from "./lib/validators";
import { enqueueNotification } from "./notifications";

/**
 * Borrow requests / loans.
 *
 * Authorization rules (enforced here, not in the UI):
 *   - request:      any signed-in user, never on their own tool
 *   - cancel:       the borrower, while pending
 *   - approve/decline: the tool's owner, while pending
 *   - markReturned: the tool's owner (the lender confirms they got it back)
 *   - allLoans:     admins only
 */

async function loadLoan(ctx: Ctx, loanId: Id<"loans">) {
  const loan = await ctx.db.get("loans", loanId);
  if (!loan) notFound("Request not found");
  return loan;
}

function assertStatus(loan: Doc<"loans">, expected: Doc<"loans">["status"]) {
  if (loan.status !== expected) {
    badRequest(`This request is ${loan.status}, not ${expected}`);
  }
}

export const request = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.string(),
    endDate: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { toolId, startDate, endDate, message }) => {
    const me = await requireUser(ctx);
    const tool = await ctx.db.get("tools", toolId);
    if (!tool) notFound("Listing not found");
    if (tool.ownerId === me._id) badRequest("You can't borrow your own tool");

    if (!isIsoDate(startDate) || !isIsoDate(endDate)) badRequest("Dates must be YYYY-MM-DD");
    const today = toIsoDate(Date.now());
    if (startDate < today) badRequest("Start date can't be in the past");
    if (endDate < startDate) badRequest("End date must be on or after the start date");
    if (daysBetween(startDate, endDate) + 1 > LIMITS.maxLoanDays) {
      badRequest(`Loans are limited to ${LIMITS.maxLoanDays} days`);
    }
    if (startDate > addDays(today, LIMITS.maxDaysAhead)) {
      badRequest(`You can book at most ${LIMITS.maxDaysAhead} days ahead`);
    }
    const note = message?.trim() ?? "";
    if (note.length > LIMITS.messageMax) {
      badRequest(`Message must be at most ${LIMITS.messageMax} characters`);
    }

    // Reject dates already promised to someone else.
    const approved = await ctx.db
      .query("loans")
      .withIndex("by_tool_status", (q) => q.eq("toolId", toolId).eq("status", "approved"))
      .collect();
    if (approved.some((l) => rangesOverlap(l.startDate, l.endDate, startDate, endDate))) {
      badRequest("The tool is already booked for some of those dates");
    }
    // One open request per borrower per tool keeps the lender's inbox sane.
    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool_status", (q) => q.eq("toolId", toolId).eq("status", "pending"))
      .collect();
    if (pending.some((l) => l.borrowerId === me._id)) {
      badRequest("You already have a pending request for this tool");
    }

    const loanId = await ctx.db.insert("loans", {
      toolId,
      ownerId: tool.ownerId,
      borrowerId: me._id,
      toolName: tool.name,
      startDate,
      endDate,
      status: "pending",
      message: note || undefined,
    });
    await enqueueNotification(ctx, loanId, "request.created");
    return loanId;
  },
});

export const approve = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== me._id) forbidden("Only the lender can approve this request");
    assertStatus(loan, "pending");

    const approved = await ctx.db
      .query("loans")
      .withIndex("by_tool_status", (q) => q.eq("toolId", loan.toolId).eq("status", "approved"))
      .collect();
    if (approved.some((l) => rangesOverlap(l.startDate, l.endDate, loan.startDate, loan.endDate))) {
      badRequest("These dates overlap a loan you already approved");
    }

    const now = Date.now();
    await ctx.db.patch("loans", loanId, { status: "approved", decidedAt: now });
    await enqueueNotification(ctx, loanId, "request.approved");

    // Any other pending request for overlapping dates can no longer be
    // honoured; decline it now instead of leaving the borrower waiting.
    const pending = await ctx.db
      .query("loans")
      .withIndex("by_tool_status", (q) => q.eq("toolId", loan.toolId).eq("status", "pending"))
      .collect();
    for (const other of pending) {
      if (rangesOverlap(other.startDate, other.endDate, loan.startDate, loan.endDate)) {
        await ctx.db.patch("loans", other._id, { status: "declined", decidedAt: now });
        await enqueueNotification(ctx, other._id, "request.auto_declined");
      }
    }
  },
});

export const decline = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== me._id) forbidden("Only the lender can decline this request");
    assertStatus(loan, "pending");
    await ctx.db.patch("loans", loanId, { status: "declined", decidedAt: Date.now() });
    await enqueueNotification(ctx, loanId, "request.declined");
  },
});

export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.borrowerId !== me._id) forbidden("Only the borrower can cancel this request");
    assertStatus(loan, "pending");
    await ctx.db.patch("loans", loanId, { status: "cancelled", decidedAt: Date.now() });
    await enqueueNotification(ctx, loanId, "request.cancelled");
  },
});

export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const me = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== me._id) forbidden("Only the lender can mark this loan returned");
    assertStatus(loan, "approved");
    await ctx.db.patch("loans", loanId, { status: "returned", returnedAt: Date.now() });
    await enqueueNotification(ctx, loanId, "loan.returned");
  },
});

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** Automation history for a loan, newest first (for "Reminder sent 2 days ago"). */
async function activityFor(ctx: Ctx, loanId: Id<"loans">) {
  const events = await ctx.db
    .query("automationEvents")
    .withIndex("by_loan", (q) => q.eq("loanId", loanId))
    .collect();
  return events
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((e) => ({
      kind: e.kind,
      event: e.event ?? null,
      status: e.status,
      attempts: e.attempts,
      updatedAt: e.updatedAt,
    }));
}

async function present(ctx: Ctx, loan: Doc<"loans">, viewer: "borrower" | "lender" | "admin") {
  const today = toIsoDate(Date.now());
  const [owner, borrower] = await Promise.all([
    ctx.db.get("users", loan.ownerId),
    ctx.db.get("users", loan.borrowerId),
  ]);
  return {
    _id: loan._id,
    _creationTime: loan._creationTime,
    toolId: loan.toolId,
    toolName: loan.toolName,
    startDate: loan.startDate,
    endDate: loan.endDate,
    status: loan.status,
    message: loan.message ?? null,
    overdue: loan.status === "approved" && loan.endDate < today,
    lenderName: publicName(owner),
    lenderTrusted: owner?.trustedLender ?? false,
    borrowerName: publicName(borrower),
    // Admins need to know who to contact; peers only ever get first names.
    ...(viewer === "admin"
      ? { lenderEmail: owner?.email ?? null, borrowerEmail: borrower?.email ?? null }
      : {}),
    activity: await activityFor(ctx, loan._id),
  };
}

export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", me._id))
      .order("desc")
      .take(100);
    return await Promise.all(loans.map((l) => present(ctx, l, "borrower")));
  },
});

export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const me = await getCurrentUser(ctx);
    if (!me) return [];
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", me._id))
      .order("desc")
      .take(100);
    return await Promise.all(loans.map((l) => present(ctx, l, "lender")));
  },
});

export const allLoans = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const loans = await ctx.db.query("loans").order("desc").take(200);
    return await Promise.all(loans.map((l) => present(ctx, l, "admin")));
  },
});
