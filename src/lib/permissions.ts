/**
 * Permission catalogue + role → permission baseline.
 * Least-privilege by default (SRS §10). Role assignment rules that are not yet
 * confirmed by the business are marked in docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md.
 */

export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",
  JOB_READ: "job.read",
  JOB_CREATE: "job.create",
  JOB_RETRY: "job.retry",
  RENAME_APPLY: "rename.apply",
  SCHEDULE_EDIT: "schedule.edit",
  SCHEDULE_APPROVE: "schedule.approve",
  BOOKING_REVIEW: "booking.review",
  BOOKING_EXPORT: "booking.export",
  PDF_COMBINE: "pdf.combine",
  CONTAINER_SEARCH: "container.search",
  EXP_RUN: "exp.run",
  REVIEW_READ: "review.read",
  REVIEW_RESOLVE: "review.resolve",
  CONTRACT_APPROVE: "contract.approve",
  AUDIT_READ: "audit.read",
  ADMIN_USERS: "admin.users",
  ADMIN_REFERENCE: "admin.reference",
  ADMIN_INTEGRATION: "admin.integration",
  // Super Admin Control Center: system/user/error/process/db monitoring. Granted
  // to ADMIN only (ADMIN = every permission); enforced on the backend on every
  // page, server action and API that exposes monitoring data.
  SYSTEM_MONITOR: "system.monitor",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  [PERMISSIONS.DASHBOARD_VIEW]: "View the portal dashboard",
  [PERMISSIONS.JOB_READ]: "View jobs and job history",
  [PERMISSIONS.JOB_CREATE]: "Create / submit intake jobs",
  [PERMISSIONS.JOB_RETRY]: "Retry or reprocess jobs",
  [PERMISSIONS.RENAME_APPLY]: "Apply a PDF rename plan (copy files to the output dir)",
  [PERMISSIONS.SCHEDULE_EDIT]: "Edit shipment schedule line data in-portal",
  [PERMISSIONS.SCHEDULE_APPROVE]: "Submit / approve edited shipment schedule lines",
  [PERMISSIONS.BOOKING_REVIEW]: "Review / correct extracted booking values",
  [PERMISSIONS.BOOKING_EXPORT]: "Download booking PDFs, originals, and batch ZIPs",
  [PERMISSIONS.PDF_COMBINE]: "Run the PDF Combiner and download combined PDFs",
  [PERMISSIONS.CONTAINER_SEARCH]: "Run CTG Port container searches and download the result PDF",
  [PERMISSIONS.EXP_RUN]: "Run EXP Automation (fill/verify EXP corrections & duplicates, download EXP PDFs)",
  [PERMISSIONS.REVIEW_READ]: "View the review queue",
  [PERMISSIONS.REVIEW_RESOLVE]: "Resolve / reject review tickets",
  [PERMISSIONS.CONTRACT_APPROVE]: "Approve a draft Sales Contract for submission",
  [PERMISSIONS.AUDIT_READ]: "View the audit trail",
  [PERMISSIONS.ADMIN_USERS]: "Manage users and roles",
  [PERMISSIONS.ADMIN_REFERENCE]: "Manage reference / mapping data",
  [PERMISSIONS.ADMIN_INTEGRATION]: "Manage integration adapters",
  [PERMISSIONS.SYSTEM_MONITOR]: "Super Admin Control Center: monitor users, system, processes, database, and errors",
};

// Baseline least-privilege role → permission map.
export const ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  ADMIN: Object.values(PERMISSIONS),
  // Commercial users are restricted to the Processes section only (see
  // ROLE_SECTIONS below): nav, direct-URL and the backend actions for the other
  // sections (Dashboard, Jobs list, Review Queue, Audit Trail, Administration)
  // are all blocked. They keep every permission the process MODULES need to run
  // (JOB_* is used by the modules' upload/status/retry paths), but NOT the
  // permissions that only unlock those other sections (DASHBOARD_VIEW is unused,
  // REVIEW_READ/RESOLVE gate the Review Queue, AUDIT_READ gates the Audit Trail).
  COMMERCIAL: [
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
  ],
  MERCHANDISER: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.JOB_READ,
    PERMISSIONS.JOB_CREATE,
    PERMISSIONS.SCHEDULE_EDIT,
    PERMISSIONS.BOOKING_EXPORT,
    PERMISSIONS.REVIEW_READ,
  ],
  REVIEWER: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.JOB_READ,
    PERMISSIONS.BOOKING_REVIEW,
    PERMISSIONS.REVIEW_READ,
    PERMISSIONS.REVIEW_RESOLVE,
  ],
  VIEWER: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.JOB_READ],
};

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  ADMIN: "Full administrative access",
  COMMERCIAL: "Processes only: runs the commercial automation modules",
  MERCHANDISER: "Forwards order packages, views progress",
  REVIEWER: "Disposes review-queue exceptions",
  VIEWER: "Read-only consumer of contract data",
};

/* ------------------------------------------------------------------ *
 * Top-level portal sections (nav areas + their routes).
 *
 * Section access is enforced SEPARATELY from fine-grained permissions
 * because the process modules share permissions with the standalone
 * sections (e.g. a module's status polling needs JOB_READ, which also
 * underlies the Jobs list). A role listed in ROLE_SECTIONS may open ONLY
 * the sections named; a role that is absent may open every section.
 * ------------------------------------------------------------------ */
export type PortalSection = "dashboard" | "processes" | "jobs" | "review" | "audit" | "admin";

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  "dashboard",
  "processes",
  "jobs",
  "review",
  "audit",
  "admin",
];

/** Roles restricted to a subset of sections. Absent role = all sections. */
export const ROLE_SECTIONS: Record<string, PortalSection[]> = {
  COMMERCIAL: ["processes"],
};

/** Sections a role may open, or null when the role is unrestricted. */
export function roleAllowedSections(role: string): PortalSection[] | null {
  return ROLE_SECTIONS[(role ?? "").toUpperCase()] ?? null;
}

/** Whether a role may open a given top-level section. */
export function roleCanAccessSection(role: string, section: PortalSection): boolean {
  const allowed = roleAllowedSections(role);
  return allowed === null || allowed.includes(section);
}

/** The landing route after login for a role: its first allowed section. */
export function landingPathForRole(role: string): string {
  return roleCanAccessSection(role, "dashboard") ? "/dashboard" : "/modules";
}
