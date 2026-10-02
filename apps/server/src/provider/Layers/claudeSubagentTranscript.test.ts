// @effect-diagnostics nodeBuiltinImport:off - fixtures lay out Claude Code's config directory with node:path.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  claudeSubagentTranscriptEntries,
  readClaudeSubagentTranscript,
} from "./claudeSubagentTranscript.ts";

const line = (value: unknown) => JSON.stringify(value);

/** A subagent's transcript as Claude Code writes it. */
const TRANSCRIPT = [
  line({ type: "user", message: { role: "user", content: "Count the files at the top level." } }),
  line({ type: "attachment", attachment: { type: "skill_listing" } }),
  line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Listing the folder." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls -A", description: "List top-level entries" },
        },
      ],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts\nb.ts" }],
    },
  }),
  line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "missing.ts" } },
      ],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          is_error: true,
          content: [{ type: "text", text: "File does not exist." }],
        },
      ],
    },
  }),
  "{not json",
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "There are 2 files." }] },
  }),
];

describe("claudeSubagentTranscriptEntries", () => {
  it("keeps the prompt, messages and tool calls with their results, before the report", () => {
    expect(claudeSubagentTranscriptEntries(TRANSCRIPT)).toEqual({
      entries: [
        { _tag: "prompt", text: "Count the files at the top level." },
        { _tag: "message", text: "Listing the folder." },
        {
          _tag: "tool",
          title: "Bash: List top-level entries",
          input: "ls -A",
          output: "a.ts\nb.ts",
          failed: false,
        },
        {
          _tag: "tool",
          title: "Read: missing.ts",
          input: JSON.stringify({ file_path: "missing.ts" }, null, 2),
          output: "File does not exist.",
          failed: true,
        },
      ],
    });
  });
});

it.layer(NodeServices.layer)("readClaudeSubagentTranscript", (it) => {
  it.effect("finds the transcript by session and agent under any project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-config-" });
      const subagents = NodePath.join(
        configDir,
        "projects",
        "-Users-me-app",
        "session-1",
        "subagents",
      );
      yield* fs.makeDirectory(NodePath.join(configDir, "projects", "-Users-me-other"), {
        recursive: true,
      });
      yield* fs.makeDirectory(subagents, { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(subagents, "agent-a1b2.jsonl"),
        `${TRANSCRIPT.join("\n")}\n`,
      );

      const found = yield* readClaudeSubagentTranscript(configDir, "session-1", "a1b2");
      expect(found.entries[0]).toEqual({
        _tag: "prompt",
        text: "Count the files at the top level.",
      });
      expect(yield* readClaudeSubagentTranscript(configDir, "session-1", "missing")).toEqual({
        entries: [],
      });
      expect(yield* readClaudeSubagentTranscript(configDir, "../escape", "a1b2")).toEqual({
        entries: [],
      });
    }),
  );
});
