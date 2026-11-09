import { v, type Infer } from "convex/values";

export const CATEGORIES = [
  "power_tools",
  "hand_tools",
  "garden",
  "kitchen",
  "camping",
  "cleaning",
  "other",
] as const;

export const CONDITIONS = ["new", "good", "fair", "worn"] as const;

export const categoryValidator = v.union(
  v.literal("power_tools"),
  v.literal("hand_tools"),
  v.literal("garden"),
  v.literal("kitchen"),
  v.literal("camping"),
  v.literal("cleaning"),
  v.literal("other"),
);

export const conditionValidator = v.union(
  v.literal("new"),
  v.literal("good"),
  v.literal("fair"),
  v.literal("worn"),
);

export type Category = Infer<typeof categoryValidator>;
export type Condition = Infer<typeof conditionValidator>;

export const LIMITS = {
  nameMax: 80,
  descriptionMax: 500,
  messageMax: 300,
  maxLoanDays: 30,
  maxDaysAhead: 180,
} as const;
