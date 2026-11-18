"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Season filter + season-aware Summary download, mounted at the top of the
 * Sales Contract list page. The selected season is persisted in the URL
 * (`?season=4-2026`) so refreshes, back/forward, and bookmarks all keep the
 * same filter. User rule 2026-11-12.
 *
 * The option keys are `"<season>-<poYear>"` — exactly the format the H&M PO
 * PDF shows in its "Season:" field (e.g. "4-2026"). An empty value clears
 * the filter (all seasons).
 */
export interface SeasonOption {
  /** "<season>-<poYear>", e.g. "4-2026" — the URL value */
  key: string;
  /** Human label shown in the dropdown, e.g. "Season 4 · 2026" */
  label: string;
  /** How many POs fall in this season across all contracts */
  poCount: number;
}

export function SalesContractSeasonFilter({
  options,
  active,
}: {
  options: SeasonOption[];
  active: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const onChange = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("season", next);
    else params.delete("season");
    const qs = params.toString();
    startTransition(() => {
      router.push(`/sales-contract${qs ? `?${qs}` : ""}`);
    });
  };

  const downloadHref = active
    ? `/api/sales-contract/summary?season=${encodeURIComponent(active)}`
    : `/api/sales-contract/summary`;

  return (
    <div className="card flex flex-wrap items-center gap-3 text-xs">
      <label className="font-semibold text-slate-700">Season</label>
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="border border-slate-200 rounded px-2 py-1 bg-white text-xs min-w-[180px]"
        aria-label="Filter by season"
      >
        <option value="">All seasons ({totalPos(options)} POs)</option>
        {options.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label} ({opt.poCount})
          </option>
        ))}
      </select>
      {active ? (
        <>
          <span className="text-slate-400">·</span>
          <button
            type="button"
            onClick={() => onChange("")}
            className="btn-ghost text-xs"
          >
            Clear
          </button>
        </>
      ) : null}
      <span className="flex-1" />
      <a
        href={downloadHref}
        download
        className="btn-primary text-xs"
        title={active
          ? `Download the Summary Excel scoped to season ${active}`
          : "Download the Summary Excel across every season"}
      >
        ⬇ Download Summary Excel{active ? ` · ${active}` : ""}
      </a>
    </div>
  );
}

function totalPos(options: SeasonOption[]): number {
  return options.reduce((n, o) => n + o.poCount, 0);
}
