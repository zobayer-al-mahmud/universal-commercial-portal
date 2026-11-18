"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { SeasonOption } from "@/components/SalesContractSeasonFilter";

/**
 * Season filter for the per-contract detail page (/sales-contract/[id]).
 * Same URL pattern as the list page (`?season=4-2026`), but scoped to the
 * seasons that actually exist on THIS contract's POs — a season the contract
 * never used shouldn't show up in its own dropdown.
 *
 * Owns the Download .xlsx button too, so the one click respects the current
 * season filter without the page-level header having to turn into a client
 * component.
 */
export function SalesContractDetailSeasonFilter({
  contractId,
  options,
  active,
}: {
  contractId: string;
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
      router.push(`/sales-contract/${contractId}${qs ? `?${qs}` : ""}`);
    });
  };

  const downloadHref = active
    ? `/api/sales-contract/${contractId}/sheet?season=${encodeURIComponent(active)}`
    : `/api/sales-contract/${contractId}/sheet`;

  return (
    <div className="card flex flex-wrap items-center gap-3 text-xs">
      <label className="font-semibold text-slate-700">Season</label>
      <select
        value={active}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending || options.length === 0}
        className="border border-slate-200 rounded px-2 py-1 bg-white text-xs min-w-[180px]"
        aria-label="Filter this contract by season"
      >
        <option value="">
          All seasons{options.length > 0 ? ` (${totalPos(options)} POs)` : ""}
        </option>
        {options.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label} ({opt.poCount})
          </option>
        ))}
      </select>
      {active ? (
        <>
          <span className="text-slate-400">·</span>
          <button type="button" onClick={() => onChange("")} className="btn-ghost text-xs">
            Clear
          </button>
        </>
      ) : null}
      {options.length === 0 ? (
        <span className="text-[11px] text-slate-400">No PO has a Season value yet.</span>
      ) : null}
      <span className="flex-1" />
      <a
        href={downloadHref}
        download
        className="btn-primary text-xs"
        title={active
          ? `Download this contract's .xlsx scoped to season ${active}`
          : "Download this contract's full .xlsx"}
      >
        ⬇ Download .xlsx{active ? ` · ${active}` : ""}
      </a>
    </div>
  );
}

function totalPos(options: SeasonOption[]): number {
  return options.reduce((n, o) => n + o.poCount, 0);
}
