/**
 * UD Automation — the four BGMEA factory accounts.
 *
 * Keyed by the STABLE BGMEA factory id (never the display name), so credential
 * env-var names, DB rows and workflow scoping all stay stable even if a display
 * name is edited. Every UD record, upload, import and saved value is scoped to
 * one of these ids so one factory's data can never appear in another's workflow.
 *
 * Pure data — no I/O. Seeded into the Factory table by prisma/seed.ts.
 */

export interface FactoryDef {
  /** Stable BGMEA factory id. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** Combined label, e.g. "1095 - ABM FASHIONS LTD." */
  label: string;
  sortOrder: number;
}

export const FACTORIES: readonly FactoryDef[] = [
  { id: "1095", name: "ABM FASHIONS LTD.", label: "1095 - ABM FASHIONS LTD.", sortOrder: 0 },
  { id: "4148", name: "ANANTA GARMENTS LTD.", label: "4148 - ANANTA GARMENTS LTD.", sortOrder: 1 },
  { id: "4149", name: "ANANTA JEANS WEAR LTD.", label: "4149 - ANANTA JEANS WEAR LTD.", sortOrder: 2 },
  { id: "2966", name: "ANANTA SPORTSWEAR LTD", label: "2966 - ANANTA SPORTSWEAR LTD", sortOrder: 3 },
] as const;

const BY_ID = new Map(FACTORIES.map((f) => [f.id, f]));

/** A known factory id? (Guard against a tampered/forged factoryId.) */
export function isKnownFactory(id: string): boolean {
  return BY_ID.has(id);
}

export function factoryById(id: string): FactoryDef | undefined {
  return BY_ID.get(id);
}

export function factoryLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}
