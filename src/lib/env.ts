import { z } from "zod";

/**
 * Centralised, validated environment access (SRS Â§5.2, SC-NFR-08).
 * No business value or secret is hardcoded elsewhere in the codebase.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 chars"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  STORAGE_ROOT: z.string().default("./var/storage"),
  // Read-only directory holding the scanned PDFs for the PDF-rename apply step.
  RENAME_INPUT_DIR: z.string().optional().or(z.literal("")),
  INTEGRATION_MODE: z.enum(["mock", "dryrun", "live"]).default("mock"),
  AUTO_SUBMIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OCR_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // OCR engine config (used by the PDF File Rename module for scanned copies).
  // Tesseract language + the directory that holds `<lang>.traineddata`. The
  // traineddata lives under var/ (git-ignored) so it is never committed; on the
  // first run it is downloaded there if absent and network is available.
  OCR_LANG: z.string().default("eng"),
  OCR_TESSDATA_DIR: z.string().default("./var/ocr-tessdata"),
  // How many leading pages of a scanned PDF to OCR when hunting for the invoice
  // number (it is on the first declaration page in every observed sample).
  OCR_MAX_PAGES: z.coerce.number().int().positive().max(10).default(2),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().or(z.literal("")),

  // --- Damco Shipper Portal (Booking Correction) --------------------------
  // Credentials come ONLY from the environment / a secrets manager – never from
  // source. They are read solely by the live adapter path, which stays gated
  // behind DAMCO_LIVE_ENABLED + INTEGRATION_MODE=live. In mock/dryrun they are
  // unused. A live run never performs a status-changing portal action on its own.
  // The single authorised bot entry point (the portal dashboard). The bot logs
  // in here and navigates the portal UI to search/open bookings – no other
  // portal URL or example booking-detail deep link is retained or constructed.
  DAMCO_PORTAL_URL: z.string().default("https://booking.damco.com/ShipperPortalWeb/ViewDashboardAction.action"),
  DAMCO_USERNAME: z.string().optional().or(z.literal("")),
  DAMCO_PASSWORD: z.string().optional().or(z.literal("")),
  DAMCO_LIVE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Live runs always use a VISIBLE local browser (Chrome/Edge/Brave executable).
  DAMCO_BROWSER_PATH: z.string().optional().or(z.literal("")),
  DAMCO_CDP_PORT: z.coerce.number().int().min(1024).max(65535).default(9333),
  DAMCO_SESSION_DIR: z.string().default("./var/damco-session"),
  DAMCO_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  DAMCO_DEFAULT_COMPANY: z.string().default("ANANTA GARMENTS LIMITED"),
  DAMCO_DEFAULT_BUYER: z.string().default("H&M HENNES & MAURITZ GBC AB"),

  // --- Booking Correction batch upload limits -----------------------------
  BOOKING_MAX_FILES: z.coerce.number().int().positive().default(25),
  BOOKING_MAX_FILE_MB: z.coerce.number().positive().default(20),
  BOOKING_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  // Gross-weight tolerance (kg) and carton/qty precision policy (Â§9 matching).
  BOOKING_GROSS_WEIGHT_TOLERANCE_KG: z.coerce.number().nonnegative().default(0.5),

  // --- Sales Contract bulk-PDF batch limits (module 1, Oct-2026 addendum Â§3) --
  SALES_MAX_FILES: z.coerce.number().int().positive().default(50),
  SALES_MAX_FILE_MB: z.coerce.number().positive().default(20),
  SALES_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  // Gate for AC-03: unless an authorised numbering + Buyer-Code assignment rule
  // is configured, new-contract creation is BLOCKED and routed to review.
  SALES_AUTO_CREATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // --- H&M Sales Contract three-PDF-set workflow (module 1 Oct-2026) ---------
  // The user's live Sales Contract workbook. The writer NEVER modifies this
  // file; it is only read and copyFile'd to a new output path. Leave blank to
  // force the user to upload the template themselves.
  SALES_CONTRACT_TEMPLATE_PATH: z
    .string()
    .optional()
    .or(z.literal("")),
  SALES_CONTRACT_MAX_FILE_MB: z.coerce.number().positive().default(20),

  // --- Customs Invoice Generation (module 3) --------------------------------
  // Folder holding the country-wise `<invoiceNo> <countryCode>.xlsx` templates.
  // The writer reads from here (never modifies the originals); fresh copies are
  // produced per download.
  // Default = the in-repo drop (resolved against the process cwd = repo root).
  // Override in `.env` with an absolute path on deployments where the folder
  // lives elsewhere.
  CUSTOMS_INVOICE_TEMPLATE_DIR: z
    .string()
    .default("./Customs Invoice templates and sample files"),
  CUSTOMS_INVOICE_MAX_FILE_MB: z.coerce.number().positive().default(20),

  // --- PDF Combiner -----------------------------------------------------------
  // Server folder whose immediate sub-folders are offered for selection. Read
  // only: source PDFs are never modified, moved or deleted. Blank = disabled.
  PDF_COMBINER_ROOT: z.string().optional().or(z.literal("")),
  // Backend master Excel that seeds the UCP-managed "active" copy on first use.
  // Default = the real drop in docs/. After seeding, UCP works from its own
  // active copy under STORAGE_ROOT; this path is only read to seed/re-seed.
  PDF_COMBINER_MASTER_PATH: z
    .string()
    .default("./docs/INCENTIV SET COMBINER FORMET FINAL - exp sirial.xlsx"),
  // Timeout (ms) for a single filesystem access to the (often network/UNC)
  // source root, so a dead/unreachable share fails fast with an actionable
  // message instead of hanging the request.
  PDF_COMBINER_FS_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  PDF_COMBINER_MAX_FOLDERS: z.coerce.number().int().positive().default(20),
  PDF_COMBINER_MAX_ROWS: z.coerce.number().int().positive().default(1000),
  PDF_COMBINER_MAX_INDEXED_FILES: z.coerce.number().int().positive().default(50000),
  PDF_COMBINER_MAX_MASTER_MB: z.coerce.number().positive().default(10),

  // --- PDF File Rename (module 4, folder workflow) ---------------------------
  // Base directory holding the dedicated per-document-type folders (e.g.
  // "FCR EXTRACT & RENAME", "SHIPPING BILL SOFT COPY", "WEEK- 41 SHIPPING BILL
  // SCAN COPY"). Each immediate sub-folder is offered in the UI. Read-only:
  // originals are never modified. Default = the in-repo drop (resolved against
  // the process cwd = repo root); override with an absolute path on deployments.
  PDF_RENAME_ROOT: z.string().default("./PDF File Rename"),
  // Renamed copies are written into this sub-folder of each dedicated folder,
  // so FCR / soft-copy / scanned outputs never mix and originals stay intact.
  PDF_RENAME_OUTPUT_SUBDIR: z.string().default("UCP Renamed"),
  PDF_RENAME_MAX_FILES: z.coerce.number().int().positive().default(2000),

  // --- Container Module (CTG Port / cpatos.gov.bd) ----------------------------
  // The Port Community System entry page (holds the public container search
  // form `frm3` AND the login modal `frmmodal`). Verified live 2026-10-24.
  CTG_PORT_PCS_URL: z.string().default("https://www.cpatos.gov.bd/pcs/"),
  // Optional PCS login. The container search itself is PUBLIC (no login needed),
  // but when credentials are configured the bot signs in first (the authority's
  // operational account, per the user's workflow). Read ONLY by the live adapter;
  // never logged, returned, or written to disk. CAPTCHA/OTP are never bypassed.
  CTG_PORT_USERNAME: z.string().optional().or(z.literal("")),
  CTG_PORT_PASSWORD: z.string().optional().or(z.literal("")),
  // Visible browser for the automation. Reuses the Damco browser binary by
  // default but runs on its own CDP port + profile so the two never clash.
  CONTAINER_BROWSER_PATH: z.string().optional().or(z.literal("")),
  CONTAINER_CDP_PORT: z.coerce.number().int().min(1024).max(65535).default(9334),
  CONTAINER_SESSION_DIR: z.string().default("./var/container-session"),
  CONTAINER_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  // Where captured container result PDFs are stored (under STORAGE_ROOT).
  CONTAINER_LIVE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured environment must not boot silently.
  console.error("âŒ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
