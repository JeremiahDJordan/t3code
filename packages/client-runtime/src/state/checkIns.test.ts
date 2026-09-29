import { BackgroundCommandId, type ThreadBackgroundCommand, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { backgroundCommandStatusLabel } from "./checkIns.ts";

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
