import { z } from "zod";

/**
 * Centralised, validated environment access (SRS §5.2, SC-NFR-08).
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
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().or(z.literal("")),

  // --- Damco Shipper Portal (Booking Correction) --------------------------
  // Credentials come ONLY from the environment / a secrets manager — never from
  // source. They are read solely by the live adapter path, which stays gated
  // behind DAMCO_LIVE_ENABLED + INTEGRATION_MODE=live. In mock/dryrun they are
  // unused. A live run never performs a status-changing portal action on its own.
  DAMCO_PORTAL_URL: z.string().default("https://booking.damco.com/ShipperPortalWeb/"),
  DAMCO_USERNAME: z.string().optional().or(z.literal("")),
  DAMCO_PASSWORD: z.string().optional().or(z.literal("")),
  DAMCO_LIVE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DAMCO_DEFAULT_COMPANY: z.string().default("ANANTA GARMENTS LIMITED"),
  DAMCO_DEFAULT_BUYER: z.string().default("H&M HENNES & MAURITZ GBC AB"),

  // --- Booking Correction batch upload limits -----------------------------
  BOOKING_MAX_FILES: z.coerce.number().int().positive().default(25),
  BOOKING_MAX_FILE_MB: z.coerce.number().positive().default(20),
  BOOKING_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),
  // Gross-weight tolerance (kg) and carton/qty precision policy (§9 matching).
  BOOKING_GROSS_WEIGHT_TOLERANCE_KG: z.coerce.number().nonnegative().default(0.5),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured environment must not boot silently.
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
