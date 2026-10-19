import { describe, it, expect } from "vitest";
import { resolveApplyActions, type ApplyItem } from "@/server/pdf-rename/apply";

const items: ApplyItem[] = [
  { id: "a", originalName: "1 (1).pdf", targetName: "64931.pdf", status: "planned", applied: false },
  { id: "b", originalName: "1 (2).pdf", targetName: "64883.pdf", status: "planned", applied: false },
  { id: "c", originalName: "1 (3).pdf", targetName: null, status: "skipped", applied: false },
  { id: "d", originalName: "1 (4).pdf", targetName: "64931.pdf", status: "planned", applied: false }, // intra-run collision
  { id: "e", originalName: "1 (5).pdf", targetName: "70000.pdf", status: "planned", applied: true }, // already applied
];

describe("resolveApplyActions", () => {
  it("copies only planned, free-target, present-source items", () => {
    const actions = resolveApplyActions(items, {
      sourceExists: (n) => n !== "1 (2).pdf", // b's source is missing
      targetExists: () => false,
    });
    const byId = Object.fromEntries(actions.map((a) => [a.id, a.action]));
    expect(byId.a).toBe("copy");
    expect(byId.b).toBe("missing-source");
    expect(byId.c).toBe("skipped-not-planned");
    expect(byId.d).toBe("target-exists"); // 64931.pdf already claimed by a this run
    expect(byId.e).toBe("already-applied");
  });

  it("never overwrites an existing target on disk", () => {
    const actions = resolveApplyActions([items[0]], { sourceExists: () => true, targetExists: () => true });
    expect(actions[0].action).toBe("target-exists");
  });
});
