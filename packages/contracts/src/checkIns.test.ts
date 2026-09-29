import { describe, expect, it } from "vite-plus/test";

import { CHECK_IN_CONTEXT_KIND, checkInMessageLabel } from "./checkIns.ts";

describe("checkInMessageLabel", () => {
  it("labels a message T3 sent by each of its parts, once each and in order", () => {
    expect(
      checkInMessageLabel([
        { kind: CHECK_IN_CONTEXT_KIND, label: "Background command" },
        { kind: CHECK_IN_CONTEXT_KIND, label: "Check-in" },
        { kind: CHECK_IN_CONTEXT_KIND, label: "Check-in" },
      ]),
    ).toBe("Background command · Check-in");
    expect(checkInMessageLabel([{ kind: CHECK_IN_CONTEXT_KIND }])).toBe("Check-in");
  });

  it("gives a message the user sent no label", () => {
    expect(checkInMessageLabel(undefined)).toBeNull();
    expect(checkInMessageLabel([{ kind: "file", label: "notes.md" }])).toBeNull();
  });
});
