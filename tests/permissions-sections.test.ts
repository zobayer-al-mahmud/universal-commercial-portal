import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleAllowedSections,
  roleCanAccessSection,
  landingPathForRole,
} from "@/lib/permissions";

describe("Commercial role — Processes-only section access", () => {
  it("COMMERCIAL is restricted to the processes section", () => {
    expect(roleAllowedSections("COMMERCIAL")).toEqual(["processes"]);
    expect(roleCanAccessSection("COMMERCIAL", "processes")).toBe(true);
    for (const s of ["dashboard", "jobs", "review", "audit", "admin"] as const) {
      expect(roleCanAccessSection("COMMERCIAL", s)).toBe(false);
    }
  });

  it("is case-insensitive on the role name", () => {
    expect(roleCanAccessSection("commercial", "dashboard")).toBe(false);
    expect(roleCanAccessSection("Commercial", "processes")).toBe(true);
  });

  it("unrestricted roles (ADMIN, others) may open every section", () => {
    expect(roleAllowedSections("ADMIN")).toBeNull();
    for (const s of ["dashboard", "processes", "jobs", "review", "audit", "admin"] as const) {
      expect(roleCanAccessSection("ADMIN", s)).toBe(true);
      expect(roleCanAccessSection("MERCHANDISER", s)).toBe(true);
      expect(roleCanAccessSection("UNKNOWN_ROLE", s)).toBe(true);
    }
  });

  it("COMMERCIAL lands on /modules, other roles on /dashboard", () => {
    expect(landingPathForRole("COMMERCIAL")).toBe("/modules");
    expect(landingPathForRole("ADMIN")).toBe("/dashboard");
    expect(landingPathForRole("")).toBe("/dashboard");
  });

  it("COMMERCIAL keeps the process-module permissions but drops the other-section ones", () => {
    const c = ROLE_PERMISSIONS.COMMERCIAL;
    // dropped (belong to now-blocked sections / unused)
    for (const p of [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.REVIEW_READ,
      PERMISSIONS.REVIEW_RESOLVE,
      PERMISSIONS.AUDIT_READ,
    ]) {
      expect(c).not.toContain(p);
    }
    // kept (needed to run the process modules)
    for (const p of [
      PERMISSIONS.JOB_READ,
      PERMISSIONS.JOB_CREATE,
      PERMISSIONS.JOB_RETRY,
      PERMISSIONS.CONTRACT_APPROVE,
      PERMISSIONS.RENAME_APPLY,
      PERMISSIONS.SCHEDULE_EDIT,
      PERMISSIONS.SCHEDULE_APPROVE,
      PERMISSIONS.BOOKING_REVIEW,
      PERMISSIONS.BOOKING_EXPORT,
      PERMISSIONS.PDF_COMBINE,
      PERMISSIONS.CONTAINER_SEARCH,
      PERMISSIONS.EXP_RUN,
    ]) {
      expect(c).toContain(p);
    }
  });
});
