import {
  BackgroundCommandId,
  CheckInId,
  EnvironmentId,
  type ThreadBackgroundCommand,
  type ThreadCheckIn,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { backgroundCommandStatusLabel, checkInScheduleLabel, checkInTitle } from "./checkIns.ts";

const command: ThreadBackgroundCommand = {
  id: BackgroundCommandId.make("bg-1"),
  threadId: ThreadId.make("thread-1"),
  command: "vp run test",
  cwd: "/repo",
  stdoutPath: "/repo/.t3/jobs/bg-1/stdout.log",
  stderrPath: "/repo/.t3/jobs/bg-1/stderr.log",
  status: "running",
  exitStatus: null,
  startedAt: "2026-09-28T14:15:00.000Z",
  endedAt: null,
  statusEveryMinutes: null,
  nextStatusAt: null,
  note: "",
  tailLines: 0,
  stopRequestedBy: null,
};

describe("backgroundCommandStatusLabel", () => {
  it("says only when a command that sends no updates started", () => {
    expect(backgroundCommandStatusLabel(command, "2:15 PM")).toBe("Running since 2:15 PM");
  });

  it("puts what the agent hears before the start time, which truncates first", () => {
    expect(
      backgroundCommandStatusLabel(
        {
          ...command,
          statusEveryMinutes: 20,
          nextStatusAt: "2026-09-28T14:35:00.000Z",
          notifyOn: "FAIL",
          muted: true,
          stopRequestedBy: "user",
        },
        "yesterday at 2:15 PM",
      ),
    ).toBe(
      "Stopping · muted · watching for FAIL · status updates every 20m · running since yesterday at 2:15 PM",
    );
  });

  it("drops the status update cadence once the repeat limit has ended status updates", () => {
    expect(
      backgroundCommandStatusLabel(
        { ...command, statusEveryMinutes: 20, nextStatusAt: null },
        "2:15 PM",
      ),
    ).toBe("Running since 2:15 PM");
  });

  it("says how an ended command ended while the agent is told", () => {
    expect(
      backgroundCommandStatusLabel(
        { ...command, status: "exited", exitStatus: "exit 1", endedAt: "2026-09-28T15:00:00.000Z" },
        "2:15 PM",
      ),
    ).toBe("Finished (exit 1) · telling the agent");
  });
});

const checkIn: ThreadCheckIn = {
  id: CheckInId.make("check-in-1"),
  threadId: ThreadId.make("thread-1"),
  note: "Look at the build again",
  repeatEveryMinutes: null,
  nextAt: "2026-09-28T14:40:00.000Z",
  endsAt: null,
  dueSince: null,
  deliveredCount: 0,
  createdAt: "2026-09-28T14:20:00.000Z",
};

const waitsFor = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-2"),
  title: "  Fix the build ",
};
const wait: ThreadCheckIn = { ...checkIn, nextAt: "2026-09-29T09:00:00.000Z", waitsFor };

describe("checkInTitle", () => {
  it("shows a time check-in's note", () => {
    expect(checkInTitle(checkIn)).toBe("Look at the build again");
  });

  it("names the thread a wait waits on, or stands in for a blank title", () => {
    expect(checkInTitle(wait)).toBe('When "Fix the build" finishes');
    expect(checkInTitle({ ...wait, waitsFor: { ...waitsFor, title: " " } })).toBe(
      "When another thread finishes",
    );
  });
});

describe("checkInScheduleLabel", () => {
  it("says when a one-time or repeating check-in comes", () => {
    expect(checkInScheduleLabel(checkIn, "2:40 PM")).toBe("at 2:40 PM");
    expect(checkInScheduleLabel({ ...checkIn, repeatEveryMinutes: 90 }, "2:40 PM")).toBe(
      "every 1h 30m · next 2:40 PM",
    );
  });

  it("says when a wait gives up rather than when it comes", () => {
    expect(checkInScheduleLabel(wait, "tomorrow at 9:00 AM")).toBe(
      "stops waiting tomorrow at 9:00 AM",
    );
  });

  it("says a due check-in or wait waits for the agent's turn to end", () => {
    const dueSince = "2026-09-28T14:40:00.000Z";
    expect(checkInScheduleLabel({ ...checkIn, dueSince }, "2:40 PM")).toBe(
      "due; waits for the agent to finish",
    );
    expect(checkInScheduleLabel({ ...wait, dueSince }, "9:00 AM")).toBe(
      "due; waits for the agent to finish",
    );
  });
});
