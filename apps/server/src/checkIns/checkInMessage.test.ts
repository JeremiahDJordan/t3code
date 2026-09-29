import { CheckInId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { checkInMessageText, formatCheckInMinutes } from "./checkInMessage.ts";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const base = { id: CheckInId.make("ci-1"), note: "Check the desktop build." };

describe("formatCheckInMinutes", () => {
  it("names minutes and hours in words", () => {
    expect(formatCheckInMinutes(1)).toBe("1 minute");
    expect(formatCheckInMinutes(20)).toBe("20 minutes");
    expect(formatCheckInMinutes(60)).toBe("1 hour");
    expect(formatCheckInMinutes(150)).toBe("2 hours 30 minutes");
  });
});

describe("checkInMessageText", () => {
  it("marks a one-time check-in as T3's and carries the note", () => {
    expect(
      checkInMessageText(
        { ...base, repeatEveryMinutes: null, nextAt: "2026-09-28T12:00:00.000Z", endsAt: null },
        NOW,
      ),
    ).toBe("[T3 Code check-in] Check the desktop build.");
  });

  it("tells a repeating check-in when the next one comes, when it stops, and how to stop it", () => {
    expect(
      checkInMessageText(
        {
          ...base,
          repeatEveryMinutes: 20,
          nextAt: "2026-09-28T12:20:00.000Z",
          endsAt: "2026-09-29T10:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(
      '[T3 Code check-in, every 20 minutes] Check the desktop build.\n\nThe next one is in 20 minutes. It stops in 22 hours. To stop it sooner, call cancel_check_in with checkInId "ci-1".',
    );
  });

  it("says when a repeating check-in has reached its end", () => {
    expect(
      checkInMessageText(
        {
          ...base,
          repeatEveryMinutes: 20,
          nextAt: "2026-09-28T12:20:00.000Z",
          endsAt: "2026-09-28T12:10:00.000Z",
        },
        NOW,
      ),
    ).toContain("This is the last one");
  });
});
