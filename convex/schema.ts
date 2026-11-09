import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { categoryValidator, conditionValidator } from "./lib/validators";

/**
 * Data model.
 *
 * A "loan" is a borrow request over its whole lifecycle:
 *   pending -> approved -> returned
 *   pending -> declined | cancelled
 * Keeping one table (instead of requests + loans) means there is a single
 * status machine to guard in `loans.ts` and a single id that the n8n
 * workflows reference.
 */
export default defineSchema({
  users: defineTable({
    // Stable Clerk identity (issuer|subject). Never exposed to other users.
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("user")),
    trustedLender: v.boolean(),
  }).index("by_token", ["tokenIdentifier"]),

  tools: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    category: categoryValidator,
    condition: conditionValidator,
    description: v.string(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_category", ["category"]),

  loans: defineTable({
    toolId: v.id("tools"),
    // Denormalised so "Incoming requests" is one index lookup and RBAC checks
    // don't need a second read.
    ownerId: v.id("users"),
    borrowerId: v.id("users"),
    // Snapshot, so loan history and notifications survive listing deletion.
    toolName: v.string(),
    // ISO calendar dates (YYYY-MM-DD), inclusive. Date-only avoids timezone
    // drift between borrower, lender and the daily n8n run.
    startDate: v.string(),
    endDate: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("returned"),
    ),
    message: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
  })
    .index("by_tool_status", ["toolId", "status"])
    .index("by_borrower", ["borrowerId"])
    .index("by_owner", ["ownerId"])
    .index("by_status_endDate", ["status", "endDate"]),

  /**
   * Audit trail of everything the automation layer did for a loan.
   * `idempotencyKey` is unique per logical action, so a retried n8n
   * write-back (or a retried outbound webhook) updates the existing row
   * instead of inserting a duplicate.
   */
  automationEvents: defineTable({
    loanId: v.id("loans"),
    kind: v.union(v.literal("notification"), v.literal("overdue_reminder")),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    idempotencyKey: v.string(),
    event: v.optional(v.string()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_key", ["idempotencyKey"])
    .index("by_loan", ["loanId"]),

  /** Failures reported by the n8n error workflow, surfaced to admins. */
  workflowErrors: defineTable({
    errorKey: v.string(),
    workflowName: v.string(),
    nodeName: v.optional(v.string()),
    message: v.string(),
    executionId: v.optional(v.string()),
    occurredAt: v.number(),
  }).index("by_key", ["errorKey"]),
});
