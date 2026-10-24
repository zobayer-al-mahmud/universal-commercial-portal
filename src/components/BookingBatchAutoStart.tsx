"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Dashboard auto-start (§2 of the spec): when the batch has at least one
 * pending document and the live run is idle, trigger the server action once
 * on mount. The server action is idempotent and permission-gated, so a bounce
 * (navigating back to the dashboard) never duplicates work. Users can also
 * press the visible "Start" button; this just makes the first run automatic.
 */
export function BookingBatchAutoStart(props: {
  batchId: string;
  shouldStart: boolean;
  action: (fd: FormData) => Promise<void>;
}) {
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (!props.shouldStart || started.current) return;
    started.current = true;
    const fd = new FormData();
    fd.set("batchId", props.batchId);
    // Fire the start once; the BookingLiveProgress component polls real progress
    // from the status API, so no full-page refresh loop is needed here.
    void props.action(fd).then(() => {
      setTimeout(() => router.refresh(), 800);
    });
  }, [props.action, props.batchId, props.shouldStart, router]);
  return null;
}
