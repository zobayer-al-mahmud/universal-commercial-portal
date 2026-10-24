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
  REVIEW_READ: "review.read",
  REVIEW_RESOLVE: "review.resolve",
  CONTRACT_APPROVE: "contract.approve",
  AUDIT_READ: "audit.read",
  ADMIN_USERS: "admin.users",
  ADMIN_REFERENCE: "admin.reference",
  ADMIN_INTEGRATION: "admin.integration",
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
  [PERMISSIONS.REVIEW_READ]: "View the review queue",
  [PERMISSIONS.REVIEW_RESOLVE]: "Resolve / reject review tickets",
  [PERMISSIONS.CONTRACT_APPROVE]: "Approve a draft Sales Contract for submission",
  [PERMISSIONS.AUDIT_READ]: "View the audit trail",
  [PERMISSIONS.ADMIN_USERS]: "Manage users and roles",
  [PERMISSIONS.ADMIN_REFERENCE]: "Manage reference / mapping data",
  [PERMISSIONS.ADMIN_INTEGRATION]: "Manage integration adapters",
};

// Baseline least-privilege role → permission map.
export const ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  ADMIN: Object.values(PERMISSIONS),
  COMMERCIAL: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.JOB_READ,
    PERMISSIONS.JOB_CREATE,
    PERMISSIONS.JOB_RETRY,
    PERMISSIONS.REVIEW_READ,
    PERMISSIONS.REVIEW_RESOLVE,
    PERMISSIONS.CONTRACT_APPROVE,
    PERMISSIONS.RENAME_APPLY,
    PERMISSIONS.SCHEDULE_EDIT,
    PERMISSIONS.SCHEDULE_APPROVE,
    PERMISSIONS.BOOKING_REVIEW,
    PERMISSIONS.BOOKING_EXPORT,
    PERMISSIONS.PDF_COMBINE,
    PERMISSIONS.CONTAINER_SEARCH,
    PERMISSIONS.AUDIT_READ,
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
  COMMERCIAL: "Commercial section: owns contracts, approves submissions",
  MERCHANDISER: "Forwards order packages, views progress",
  REVIEWER: "Disposes review-queue exceptions",
  VIEWER: "Read-only consumer of contract data",
};
