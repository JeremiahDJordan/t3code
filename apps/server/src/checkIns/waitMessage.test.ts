import { describe, expect, it } from "vite-plus/test";

import {
  defaultWaitNote,
  WAIT_REPLY_EXCERPT_CHARS,
  waitNoticeSummary,
  waitNoticeText,
} from "./waitMessage.ts";

const TARGET_REF = 'threadId "thread-target"';

describe("waitNoticeText", () => {
  const base = { title: "Review the docs", threadId: "thread-target", note: "" };

  it("quotes a finished thread's reply and says how to follow up", () => {
    const outcome = { kind: "finished", reply: "All links fixed.", status: "completed" } as const;
    expect(waitNoticeText({ ...base, outcome })).toBe(
      [
        `[T3 Code] The agent in thread "Review the docs" (${TARGET_REF}) finished its turn.`,
        "The end of its last reply:",
        "```",
        "All links fixed.",
        "```",
        "Read more with t3_thread_read; answer it with t3_thread_send.",
      ].join("\n"),
    );
    expect(waitNoticeSummary(base.title, outcome)).toBe('"Review the docs" finished its turn');
  });

  it("keeps the end of a long reply, where the result usually is", () => {
    const reply = `${"x".repeat(5_000)}RESULT: shipped`;
    const text = waitNoticeText({
      ...base,
      outcome: { kind: "finished", reply, status: "completed" },
    });
    const excerpt = `…${reply.slice(-WAIT_REPLY_EXCERPT_CHARS)}`;
    expect(text).toContain(`\`\`\`\n${excerpt}\n\`\`\``);
    expect(text).toContain("RESULT: shipped");
    expect(text).not.toContain("x".repeat(WAIT_REPLY_EXCERPT_CHARS + 1));
  });

  it("fences a reply so its own backticks cannot close the quote", () => {
    const reply = "Run this:\n````sh\nvp test\n````\nand ``` too";
    const text = waitNoticeText({
      ...base,
      outcome: { kind: "finished", reply, status: "completed" },
    });
    expect(text).toContain(`\`\`\`\`\`\n${reply}\n\`\`\`\`\`\n`);
  });

  it("points to t3_thread_read when the thread finished without a reply", () => {
    expect(
      waitNoticeText({ ...base, outcome: { kind: "finished", reply: "  ", status: "completed" } }),
    ).toBe(
      `[T3 Code] The agent in thread "Review the docs" (${TARGET_REF}) finished its turn.\nRead it with t3_thread_read; answer it with t3_thread_send.`,
    );
  });

  it("says when the thread's turn failed or was stopped", () => {
    const failed = { kind: "finished", reply: undefined, status: "failed" } as const;
    expect(waitNoticeText({ ...base, outcome: failed })).toContain(
      `(${TARGET_REF}) ended its turn with an error.`,
    );
    expect(waitNoticeSummary(base.title, failed)).toBe(
      '"Review the docs" ended its turn with an error',
    );
    const stopped = { kind: "finished", reply: undefined, status: "cancelled" } as const;
    expect(waitNoticeSummary(base.title, stopped)).toBe(
      '"Review the docs" was stopped before finishing its turn',
    );
  });

  it("says when the thread went away, with the waiting agent's note", () => {
    const outcome = { kind: "gone" } as const;
    expect(waitNoticeText({ ...base, note: "Merge its branch.", outcome })).toBe(
      `[T3 Code] thread "Review the docs" (${TARGET_REF}) was archived or deleted before it finished a turn.\nYour note: Merge its branch.`,
    );
    expect(waitNoticeSummary(base.title, outcome)).toBe(
      '"Review the docs" was archived or deleted',
    );
  });

  it("says when it stopped waiting, and how to wait again", () => {
    const outcome = { kind: "stopped-waiting", hours: 24 } as const;
    expect(waitNoticeText({ ...base, outcome })).toBe(
      `[T3 Code] Stopped waiting for thread "Review the docs" (${TARGET_REF}): it has not finished a turn in 24 hours. Call watch_thread to wait again, or t3_thread_read to see where it is.`,
    );
    expect(waitNoticeSummary(base.title, outcome)).toBe('Stopped waiting for "Review the docs"');
    expect(waitNoticeText({ ...base, outcome: { kind: "stopped-waiting", hours: 1 } })).toContain(
      "it has not finished a turn in 1 hour.",
    );
  });

  it("leaves out the note a wait keeps when the agent gave none", () => {
    const text = waitNoticeText({
      ...base,
      note: defaultWaitNote("Review the docs"),
      outcome: { kind: "finished", reply: "Done.", status: "completed" },
    });
    expect(text).not.toContain("Your note");
  });

  it("shortens a long title and names an empty one in the summary", () => {
    expect(waitNoticeSummary("A".repeat(100), { kind: "gone" })).toBe(
      `"${"A".repeat(60)}…" was archived or deleted`,
    );
    expect(waitNoticeSummary("  ", { kind: "gone" })).toBe(
      '"Untitled thread" was archived or deleted',
    );
  });
});
