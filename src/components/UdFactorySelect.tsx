"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Factory selector (step 1). A dropdown of the four BGMEA factories; choosing one
 * navigates to that factory's workspace. Factory selection is required before any
 * UD selection or data entry, and scopes everything that follows to that factory.
 */
export function UdFactorySelect({ factories, current = "" }: { factories: { id: string; label: string }[]; current?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(current);

  function go(id: string) {
    setValue(id);
    if (id) router.push(`/ud-automation?factory=${id}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[280px]">
        <label className="label" htmlFor="ud-factory">Factory</label>
        <select
          id="ud-factory"
          className="select"
          value={value}
          onChange={(e) => go(e.target.value)}
        >
          <option value="">Select a factory…</option>
          {factories.map((f) => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
