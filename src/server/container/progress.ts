/** Live progress steps for the CTG Port container-search workflow (spec order). */
export const CONTAINER_STEPS = [
  "Opening CTG Port",
  "Opening Port Community System",
  "Entering Container Details",
  "Searching",
  "Verifying Result",
  "Downloading PDF",
  "Download Verified",
] as const;

export type ContainerStep = (typeof CONTAINER_STEPS)[number];

/** 0-based index of a step (for a progress bar); -1 if unknown. */
export function stepIndex(step: string): number {
  return (CONTAINER_STEPS as readonly string[]).indexOf(step);
}
