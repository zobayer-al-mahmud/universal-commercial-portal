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
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured environment must not boot silently.
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
