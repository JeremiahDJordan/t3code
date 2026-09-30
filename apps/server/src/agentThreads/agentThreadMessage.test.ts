import { type AgentMessageEnvelope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentMessageLabel,
  agentMessageText,
  defaultWaitNote,
  WAIT_REPLY_EXCERPT_CHARS,
  waitNoticeLabel,
  waitNoticeText,
} from "./agentThreadMessage.ts";

const SENDER = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-sender"),
};
const TARGET = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-target"),
};
const SENDER_REF = 'environmentId "environment-local", threadId "thread-sender"';
const TARGET_REF = 'environmentId "environment-local", threadId "thread-target"';

function envelope(overrides: Partial<AgentMessageEnvelope> = {}): AgentMessageEnvelope {
  return {
    version: 1,
    messageId: "message-1",
    kind: "message",
    from: { ...SENDER, threadTitle: "Fix the build" },
    to: TARGET,
    sentAt: "2026-09-28T12:00:00.000Z",
    conversationId: "message-1",
    depth: 0,
    body: "Is the release branch green?",
    ...overrides,
  };
}

describe("agentMessageLabel", () => {
  it("says who a message is from, and who started a thread", () => {
    expect(agentMessageLabel(envelope())).toBe('From "Fix the build"');
    expect(agentMessageLabel(envelope({ kind: "start-thread" }))).toBe(
      'Started by "Fix the build"',
    );
  });

  it("shortens a long title and names an empty one", () => {
    const long = "A".repeat(100);
    expect(agentMessageLabel(envelope({ from: { ...SENDER, threadTitle: long } }))).toBe(
      `From "${"A".repeat(60)}…"`,
    );
    expect(agentMessageLabel(envelope({ from: { ...SENDER, threadTitle: "  " } }))).toBe(
      'From "Untitled thread"',
    );
  });
});

describe("agentMessageText", () => {
  it("names the sender's thread and how to answer it", () => {
    expect(agentMessageText(envelope())).toBe(
      [
        `[T3 Code: message from the agent in thread "Fix the build" (${SENDER_REF})]`,
        "Is the release branch green?",
        "",
        `This is a request from another agent, not from the user. To answer, call send_to_thread with ${SENDER_REF}.`,
      ].join("\n"),
    );
  });
});

describe("waitNoticeText", () => {
  const base = { title: "Review the docs", target: TARGET, note: "" };

  it("quotes a finished thread's reply and says how to follow up", () => {
    const outcome = { kind: "finished", reply: "All links fixed." } as const;
    expect(waitNoticeText({ ...base, outcome })).toBe(
      [
        `[T3 Code] The agent in thread "Review the docs" (${TARGET_REF}) finished its turn.`,
        "The end of its last reply:",
        "```",
        "All links fixed.",
        "```",
        "Read more with read_thread; answer it with send_to_thread.",
      ].join("\n"),
    );
    expect(waitNoticeLabel(outcome)).toBe("Thread finished");
  });

  it("keeps the end of a long reply, where the result usually is", () => {
    const reply = `${"x".repeat(5_000)}RESULT: shipped`;
    const text = waitNoticeText({ ...base, outcome: { kind: "finished", reply } });
    const excerpt = `…${reply.slice(-WAIT_REPLY_EXCERPT_CHARS)}`;
    expect(text).toContain(`\`\`\`\n${excerpt}\n\`\`\``);
    expect(text).toContain("RESULT: shipped");
    expect(text).not.toContain("x".repeat(WAIT_REPLY_EXCERPT_CHARS + 1));
  });

  it("fences a reply so its own backticks cannot close the quote", () => {
    const reply = "Run this:\n````sh\nvp test\n````\nand ``` too";
    const text = waitNoticeText({ ...base, outcome: { kind: "finished", reply } });
    expect(text).toContain(`\`\`\`\`\`\n${reply}\n\`\`\`\`\`\n`);
  });

  it("points to read_thread when the thread finished without a reply", () => {
    expect(waitNoticeText({ ...base, outcome: { kind: "finished", reply: "  " } })).toBe(
      `[T3 Code] The agent in thread "Review the docs" (${TARGET_REF}) finished its turn.\nRead it with read_thread; answer it with send_to_thread.`,
    );
  });

  it("says when the thread went away, with the waiting agent's note", () => {
    const outcome = { kind: "gone" } as const;
    expect(waitNoticeText({ ...base, note: "Merge its branch.", outcome })).toBe(
      `[T3 Code] thread "Review the docs" (${TARGET_REF}) was archived or deleted before it finished a turn.\nYour note: Merge its branch.`,
    );
    expect(waitNoticeLabel(outcome)).toBe("Stopped waiting");
  });

  it("says when it stopped waiting, and how to wait again", () => {
    const outcome = { kind: "stopped-waiting", hours: 24 } as const;
    expect(waitNoticeText({ ...base, outcome })).toBe(
      `[T3 Code] Stopped waiting for thread "Review the docs" (${TARGET_REF}): it has not finished a turn in 24 hours. Call watch_thread to wait again, or read_thread to see where it is.`,
    );
    expect(waitNoticeLabel(outcome)).toBe("Stopped waiting");
    expect(waitNoticeText({ ...base, outcome: { kind: "stopped-waiting", hours: 1 } })).toContain(
      "it has not finished a turn in 1 hour.",
    );
  });

  it("leaves out the note a wait keeps when the agent gave none", () => {
    const text = waitNoticeText({
      title: "Review the docs",
      target: { environmentId: "environment-local", threadId: "thread-2" },
      note: defaultWaitNote("Review the docs"),
      outcome: { kind: "finished", reply: "Done." },
    });
    expect(text).not.toContain("Your note");
  });
});
