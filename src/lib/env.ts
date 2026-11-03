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

  // --- Automation runtime (Linux/production) --------------------------------
  // All portal automation runs in the BACKEND browser (never the user's browser).
  // On a Linux server set AUTOMATION_HEADLESS=true so the backend browser runs
  // with no window. Engine is Chromium (required: the Container module captures
  // its result PDF via CDP Page.printToPDF, which only Chromium provides; EXP/
  // Damco/Container portal driving all work headless on Chromium). The "firefox"
  // value is reserved/forward-compat and must be validated on the host first.
  AUTOMATION_BROWSER_ENGINE: z.enum(["chromium", "firefox"]).default("chromium"),
  AUTOMATION_HEADLESS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Cross-cutting browser executable override (used when a module-specific
  // *_BROWSER_PATH is not set). On Linux, point at google-chrome / chromium.
  AUTOMATION_BROWSER_PATH: z.string().optional().or(z.literal("")),
  // After a server restart, re-queue rows left mid-run by the crash/restart.
  // false (default) = just un-stick them to a resumable state (never auto-drive
  // the live portal unattended). true = also resume processing on boot.
  AUTOMATION_RESUME_ON_BOOT: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
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
  // number. Multi-page declarations (Bill of Export + attached commercial
  // invoice) can carry the invoice box / header on a later page, so every page
  // of a typical packet is read, not just the first — the validator still only
  // accepts a labelled, cross-checked candidate.
  OCR_MAX_PAGES: z.coerce.number().int().positive().max(10).default(5),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().or(z.literal("")),
  // Login identity for the bootstrap administrator (username-based auth).
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),

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
  // Excel-driven workflow: max data rows accepted from one PackingLists.xlsx.
  BOOKING_MAX_ROWS: z.coerce.number().int().positive().default(500),
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
  // Folder holding the two bundled customs-invoice templates ("0000 AZ.xlsx"
  // and "0000 AZ Pack.xlsx"). Bundled with the repo so deploys always have
  // them; the writer reads them (never modifies) and emits a fresh copy per
  // download. Resolver picks AZ Pack when the invoice's packSet > 1, plain AZ
  // otherwise (user rule 2026-11-03) — the market/country code is no longer
  // used to pick a template.
  CUSTOMS_INVOICE_TEMPLATE_DIR: z
    .string()
    .default("./templates/customs-invoice"),
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
  // Max size per PDF for the local-folder analyze/zip endpoints (client-side flow).
  PDF_RENAME_MAX_FILE_MB: z.coerce.number().positive().default(25),
  // Deep-extraction job: min confidence to auto-rename (else → review) + workers.
  PDF_RENAME_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  PDF_RENAME_CONCURRENCY: z.coerce.number().int().positive().max(16).default(3),

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
  // Max container numbers accepted in one bulk batch.
  CONTAINER_MAX_BATCH: z.coerce.number().int().positive().default(100),
  // Max size (MB) for an uploaded .xlsx of container numbers.
  CONTAINER_MAX_FILE_MB: z.coerce.number().positive().default(5),

  // --- EXP Automation (Bangladesh Bank EXP portal) --------------------------
  // The authorised login entry point (Oracle APEX). The bot signs in here and
  // navigates the Transaction menu to the Correction / Duplicate / Search pages
  // — deep f?p links carry a session id and are not reused. Credentials come
  // ONLY from env (never source/logs); read solely by the live driver, which
  // stays gated behind EXP_LIVE_ENABLED. The correction + duplicate workflows
  // FILL and VERIFY the form only — a final Update/Submit/Acknowledge is never
  // performed by the bot (hard-coded; no flag enables it).
  EXP_PORTAL_URL: z.string().default("https://exp.bb.org.bd/ords/f?p=112:LOGIN:0:::::"),
  // Fallback credentials. The PREFERRED source is the DB credential store
  // (managed in the EXP Automation → Credentials panel, encrypted at rest); these
  // env values are used only when the store is empty, so an existing deployment
  // keeps working until the operator saves credentials in the UI.
  EXP_USERNAME: z.string().optional().or(z.literal("")),
  EXP_PASSWORD: z.string().optional().or(z.literal("")),
  // Optional dedicated key for encrypting stored portal passwords. When unset the
  // key is derived from AUTH_SECRET. Set a stable value on prod (>=16 chars) so
  // rotating AUTH_SECRET never orphans already-encrypted credentials.
  EXP_CRED_KEY: z.string().optional().or(z.literal("")),
  EXP_LIVE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // OPT-IN (default OFF): when true, the Correction + Duplicate workflows click the
  // form's **Apply Changes** save button after filling + a full read-back, then
  // CONFIRM the portal's actual success before marking the row "updated". OFF by
  // default — the bot otherwise fills and stops for manual submission. By itself
  // this does NOT tick the Duplicate "Acknowledge/Duplicate Export" checkbox; that
  // is a separate opt-in (EXP_AUTO_ACKNOWLEDGE) because it is the irreversible
  // central-bank acknowledgement. See guards.ts for the click-safety allow-list.
  EXP_AUTO_UPDATE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // OPT-IN (default OFF): for Duplicate EXP Reporting only, tick the
  // "Acknowledge/Duplicate Export" checkbox (and set the Acknowledge date) before
  // Apply Changes. Requires EXP_AUTO_UPDATE to also be on (acknowledge without a
  // save is meaningless). This performs the final, irreversible acknowledgement —
  // keep OFF until an operator has validated the fill live.
  EXP_AUTO_ACKNOWLEDGE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Visible browser for the automation (own CDP port + profile so it never
  // clashes with the Damco/Container windows).
  EXP_BROWSER_PATH: z.string().optional().or(z.literal("")),
  EXP_CDP_PORT: z.coerce.number().int().min(1024).max(65535).default(9335),
  EXP_SESSION_DIR: z.string().default("./var/exp-session"),
  EXP_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  // Max data rows accepted from one uploaded workbook.
  EXP_MAX_ROWS: z.coerce.number().int().positive().default(2000),
  // Max size (MB) for an uploaded EXP .xlsx.
  EXP_MAX_FILE_MB: z.coerce.number().positive().default(25),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured environment must not boot silently.
  console.error("âŒ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
