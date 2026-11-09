/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { addDays, toIsoDate } from "./lib/dates";

const modules = import.meta.glob("./**/*.ts");

const identity = (who: string, email = `${who}@example.com`) => ({
  subject: who,
  issuer: "https://test.clerk",
  tokenIdentifier: `https://test.clerk|${who}`,
  name: `${who[0].toUpperCase()}${who.slice(1)} Example`,
  email,
  emailVerified: true,
});

const today = () => toIsoDate(Date.now());

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(identity("alice"));
  const bob = t.withIdentity(identity("bob"));
  const carol = t.withIdentity(identity("carol"));
  const admin = t.withIdentity(identity("root", "admin@example.com"));
  for (const u of [alice, bob, carol, admin]) await u.mutation(api.users.store, {});
  const drill = await alice.mutation(api.tools.create, {
    name: "Drill",
    category: "power_tools",
    condition: "good",
    description: "18V",
  });
  return { t, alice, bob, carol, admin, drill };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("ADMIN_EMAILS", "Admin@Example.com, other@example.com");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("roles", () => {
  it("promotes only ADMIN_EMAILS (case-insensitive) to admin", async () => {
    const { alice, admin } = await setup();
    expect((await alice.query(api.users.me, {}))?.role).toBe("user");
    expect((await admin.query(api.users.me, {}))?.role).toBe("admin");
  });

  it("does not promote an unverified email", async () => {
    const t = convexTest(schema, modules);
    const sneaky = t.withIdentity({ ...identity("x", "admin@example.com"), emailVerified: false });
    await sneaky.mutation(api.users.store, {});
    expect((await sneaky.query(api.users.me, {}))?.role).toBe("user");
  });

  it("rejects unauthenticated writes", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(api.tools.create, { name: "x", category: "garden", condition: "new", description: "" }),
    ).rejects.toThrow(/Sign in/);
  });
});

describe("public catalogue", () => {
  it("exposes only name and category, never owner details", async () => {
    const { t } = await setup();
    const list = await t.query(api.tools.listPublic, {});
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["_id", "category", "name"]);
  });

  it("signed-in catalogue shows first names only", async () => {
    const { bob } = await setup();
    const [tool] = await bob.query(api.tools.listAll, {});
    expect(tool.ownerName).toBe("Alice");
    expect(JSON.stringify(tool)).not.toContain("alice@example.com");
  });
});

describe("listings", () => {
  it("only the owner can edit; owner or admin can delete", async () => {
    const { alice, bob, admin, drill } = await setup();
    const edit = { toolId: drill, name: "Drill 2", category: "power_tools" as const, condition: "fair" as const, description: "" };
    await expect(bob.mutation(api.tools.update, edit)).rejects.toThrow(/own listings/);
    await expect(admin.mutation(api.tools.update, edit)).rejects.toThrow(/own listings/);
    await alice.mutation(api.tools.update, edit);

    await expect(bob.mutation(api.tools.remove, { toolId: drill })).rejects.toThrow(/own listings/);
    await admin.mutation(api.tools.remove, { toolId: drill });
    expect(await alice.query(api.tools.listMine, {})).toHaveLength(0);
  });

  it("validates input on the server", async () => {
    const { alice } = await setup();
    await expect(
      alice.mutation(api.tools.create, { name: "   ", category: "garden", condition: "new", description: "" }),
    ).rejects.toThrow(/Name is required/);
  });
});

describe("borrowing", () => {
  it("runs the full request -> approve -> return flow with the right actor at each step", async () => {
    const { alice, bob, carol, drill } = await setup();
    const loanId = await bob.mutation(api.loans.request, {
      toolId: drill,
      startDate: today(),
      endDate: addDays(today(), 2),
    });

    // Only the lender can decide; the borrower and strangers cannot.
    await expect(bob.mutation(api.loans.approve, { loanId })).rejects.toThrow(/Only the lender/);
    await expect(carol.mutation(api.loans.approve, { loanId })).rejects.toThrow(/Only the lender/);
    await expect(carol.mutation(api.loans.cancel, { loanId })).rejects.toThrow(/Only the borrower/);
    await alice.mutation(api.loans.approve, { loanId });

    const [tool] = await carol.query(api.tools.listAll, {});
    expect(tool.availability.state).toBe("on_loan");

    await expect(bob.mutation(api.loans.markReturned, { loanId })).rejects.toThrow(/Only the lender/);
    await alice.mutation(api.loans.markReturned, { loanId });
    const [mine] = await bob.query(api.loans.myRequests, {});
    expect(mine.status).toBe("returned");
    // Each transition queued a notification for the automation layer.
    expect(mine.activity.map((a) => a.event).sort()).toEqual([
      "loan.returned",
      "request.approved",
      "request.created",
    ]);
  });

  it("cannot borrow your own tool or use invalid dates", async () => {
    const { alice, bob, drill } = await setup();
    await expect(
      alice.mutation(api.loans.request, { toolId: drill, startDate: today(), endDate: today() }),
    ).rejects.toThrow(/own tool/);
    await expect(
      bob.mutation(api.loans.request, { toolId: drill, startDate: addDays(today(), -1), endDate: today() }),
    ).rejects.toThrow(/past/);
    await expect(
      bob.mutation(api.loans.request, { toolId: drill, startDate: today(), endDate: addDays(today(), 40) }),
    ).rejects.toThrow(/limited/);
    await expect(
      bob.mutation(api.loans.request, { toolId: drill, startDate: "2026-02-30", endDate: today() }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("approving auto-declines overlapping requests and blocks double booking", async () => {
    const { alice, bob, carol, drill } = await setup();
    const a = await bob.mutation(api.loans.request, { toolId: drill, startDate: today(), endDate: addDays(today(), 3) });
    const b = await carol.mutation(api.loans.request, { toolId: drill, startDate: addDays(today(), 2), endDate: addDays(today(), 4) });
    await alice.mutation(api.loans.approve, { loanId: a });

    const [carolsRequest] = await carol.query(api.loans.myRequests, {});
    expect(carolsRequest._id).toBe(b);
    expect(carolsRequest.status).toBe("declined");
    await expect(
      carol.mutation(api.loans.request, { toolId: drill, startDate: addDays(today(), 1), endDate: addDays(today(), 1) }),
    ).rejects.toThrow(/already booked/);
  });

  it("users only see their own requests; only admins see all loans", async () => {
    const { alice, bob, carol, admin, drill } = await setup();
    await bob.mutation(api.loans.request, { toolId: drill, startDate: today(), endDate: today() });
    expect(await carol.query(api.loans.myRequests, {})).toHaveLength(0);
    expect(await carol.query(api.loans.incoming, {})).toHaveLength(0);
    expect(await alice.query(api.loans.incoming, {})).toHaveLength(1);
    await expect(alice.query(api.loans.allLoans, {})).rejects.toThrow(/Admins only/);
    const all = await admin.query(api.loans.allLoans, {});
    expect(all).toHaveLength(1);
    expect(all[0].borrowerEmail).toBe("bob@example.com");
  });
});

describe("admin", () => {
  it("only admins can mark a Trusted Lender", async () => {
    const { alice, bob, admin } = await setup();
    const me = await alice.query(api.users.me, {});
    await expect(
      bob.mutation(api.admin.setTrustedLender, { userId: me!._id, trusted: true }),
    ).rejects.toThrow(/Admins only/);
    await admin.mutation(api.admin.setTrustedLender, { userId: me!._id, trusted: true });
    const [tool] = await bob.query(api.tools.listAll, {});
    expect(tool.ownerTrusted).toBe(true);
  });
});
