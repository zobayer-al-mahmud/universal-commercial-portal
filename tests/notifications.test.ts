import { describe, it, expect } from "vitest";
import { matchesScope, resolveRecipientIds, type ScopeUser } from "@/server/notifications/notify";
import { ROLE_PERMISSIONS, PERMISSIONS, type PermissionKey } from "@/lib/permissions";

// Build one representative active user per role, with that role's real permissions.
const ROLES = ["ADMIN", "COMMERCIAL", "MERCHANDISER", "REVIEWER", "VIEWER"] as const;
const users: ScopeUser[] = ROLES.map((role) => ({
  id: `u-${role}`,
  isActive: true,
  role,
  permissions: (ROLE_PERMISSIONS[role] ?? []) as PermissionKey[],
}));
const ids = (list: ScopeUser[]) => list.map((u) => u.id);

describe("matchesScope — role-based visibility", () => {
  it("permission scope reaches exactly the roles that hold the permission (review queue)", () => {
    const got = resolveRecipientIds(users, { permission: PERMISSIONS.REVIEW_READ });
    // ADMIN (all perms), MERCHANDISER and REVIEWER hold REVIEW_READ; not COMMERCIAL/VIEWER.
    expect(got.sort()).toEqual(["u-ADMIN", "u-MERCHANDISER", "u-REVIEWER"].sort());
  });

  it("SYSTEM_MONITOR (automation errors) reaches only ADMIN", () => {
    expect(resolveRecipientIds(users, { permission: PERMISSIONS.SYSTEM_MONITOR })).toEqual(["u-ADMIN"]);
  });

  it("role scope targets just that role", () => {
    expect(resolveRecipientIds(users, { roles: ["REVIEWER"] })).toEqual(["u-REVIEWER"]);
    expect(resolveRecipientIds(users, { roles: ["ADMIN", "COMMERCIAL"] }).sort()).toEqual(["u-ADMIN", "u-COMMERCIAL"].sort());
  });

  it("all: true reaches every active user", () => {
    expect(resolveRecipientIds(users, { all: true }).sort()).toEqual(ids(users).sort());
  });

  it("userIds scope targets specific users", () => {
    expect(resolveRecipientIds(users, { userIds: ["u-VIEWER"] })).toEqual(["u-VIEWER"]);
  });

  it("criteria are a union (role OR permission)", () => {
    const got = resolveRecipientIds(users, { roles: ["VIEWER"], permission: PERMISSIONS.SYSTEM_MONITOR });
    expect(got.sort()).toEqual(["u-ADMIN", "u-VIEWER"].sort());
  });
});

describe("matchesScope — exclusions & guards", () => {
  it("excludeUserId drops the actor (no self-notification)", () => {
    const got = resolveRecipientIds(users, { all: true }, "u-ADMIN");
    expect(got).not.toContain("u-ADMIN");
    expect(got.sort()).toEqual(["u-COMMERCIAL", "u-MERCHANDISER", "u-REVIEWER", "u-VIEWER"].sort());
  });

  it("inactive users never receive, even on all:true", () => {
    const withInactive: ScopeUser[] = [...users, { id: "u-OFF", isActive: false, role: "ADMIN", permissions: [] }];
    expect(resolveRecipientIds(withInactive, { all: true })).not.toContain("u-OFF");
    expect(matchesScope({ id: "x", isActive: false, role: "ADMIN", permissions: [] }, { all: true })).toBe(false);
  });

  it("an empty scope reaches no one (fail closed — never a broadcast by accident)", () => {
    expect(resolveRecipientIds(users, {})).toEqual([]);
  });

  it("role match is case-insensitive", () => {
    expect(matchesScope(users[0], { roles: ["admin"] })).toBe(true);
  });
});
