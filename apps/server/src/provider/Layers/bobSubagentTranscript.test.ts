// @effect-diagnostics nodeBuiltinImport:off - fixtures write Bob's SQLite database with node:sqlite.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  bobSubagentTranscriptEntries,
  bobToolTitle,
  readBobSubagentTranscript,
} from "./bobSubagentTranscript.ts";

/** Bob's `messages` table, holding the given tool messages as `[taskId, data]`. */
function writeBobMessages(databasePath: string, rows: ReadonlyArray<[string, unknown]>) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
    data TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  for (const [index, [taskId, data]] of rows.entries()) {
    database
      .prepare("INSERT INTO messages VALUES (?, ?, 'tool', ?, ?)")
      .run(
        `message-${index}`,
        taskId,
        typeof data === "string" ? data : JSON.stringify(data),
        index,
      );
  }
  database.close();
}

const toolMessage = (name: string, args: unknown, content: string, displayName?: string) => ({
  role: "tool",
  content,
  toolUsage: {
    signature: { id: `call-${name}`, name, arguments: args, isError: false },
    ...(displayName ? { labels: { displayName } } : {}),
  },
});

/** The parent's record of one subagent run, as Bob stores it. */
const subagentRun = (toolCallId: string, messages: ReadonlyArray<unknown>) => ({
  role: "tool",
  content: "<task_result>Done.</task_result>",
  toolUsage: { signature: { id: toolCallId, name: "spawn_subagent", arguments: {} } },
  messages,
});

const RUN = [
  { role: "system", content: "You are a general-purpose subagent." },
  { role: "user", content: "List the folder and write REPORT.md." },
  { role: "assistant", content: "", toolCalls: [{ id: "call-list_files" }] },
  toolMessage("list_files", { path: "src", recursive: true }, "a.ts\nb.ts", "List Files in {path}"),
  { role: "assistant", content: "Two files. Writing the report next." },
  toolMessage("execute_command", { command: "wc -l a.ts" }, "12 a.ts", "Execute Command"),
  { role: "user", content: "continue", _meta: { hide: true } },
  { role: "assistant", content: "REPORT.md has been written.", stop: true },
];

describe("bobSubagentTranscriptEntries", () => {
  it("keeps the prompt, messages and tool calls before the report", () => {
    expect(bobSubagentTranscriptEntries(RUN)).toEqual({
      entries: [
        { _tag: "prompt", text: "List the folder and write REPORT.md." },
        {
          _tag: "tool",
          title: "List Files in src",
          input: JSON.stringify({ path: "src", recursive: true }, null, 2),
          output: "a.ts\nb.ts",
          failed: false,
        },
        { _tag: "message", text: "Two files. Writing the report next." },
        {
          _tag: "tool",
          title: "Execute Command",
          input: "wc -l a.ts",
          output: "12 a.ts",
          failed: false,
        },
      ],
    });
  });

  it("leaves out the report however long, since the subagent's result shows it whole", () => {
    const report = `## Findings\n${"The parser drops trailing commas. ".repeat(200)}`.trim();
    const { entries } = bobSubagentTranscriptEntries([
      { role: "user", content: "Review the parser." },
      { role: "assistant", content: report, stop: true },
    ]);
    expect(entries).toEqual([{ _tag: "prompt", text: "Review the parser." }]);
  });

  it("keeps the prompt and the newest steps of a long run", () => {
    const steps = Array.from({ length: 150 }, (_, index) =>
      toolMessage("read_file", { path: `f${index}.ts` }, "", "Read File {path}"),
    );
    const { entries, omittedEntries } = bobSubagentTranscriptEntries([
      { role: "user", content: "Read everything." },
      ...steps,
    ]);
    expect(entries).toHaveLength(100);
    expect(entries[0]).toEqual({ _tag: "prompt", text: "Read everything." });
    expect(entries[1]).toMatchObject({ title: "Read File f51.ts" });
    expect(entries.at(-1)).toMatchObject({ title: "Read File f149.ts" });
    expect(omittedEntries).toBe(51);
  });
});

describe("bobToolTitle", () => {
  it("falls back to the tool name when a placeholder has no plain argument", () => {
    expect(bobToolTitle("Read File {path}", "read_file", { path: "a.ts" })).toBe("Read File a.ts");
    expect(bobToolTitle("Read File {path}", "read_file", { path: ["a.ts"] })).toBe("read_file");
    expect(bobToolTitle(undefined, undefined, {})).toBe("Tool");
  });
});

it.layer(NodeServices.layer)("readBobSubagentTranscript", (it) => {
  const makeDatabasePath = Effect.fn("bobSubagentTranscript.test.makeDatabasePath")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-bob-subagent-" });
    return NodePath.join(directory, "bob.db");
  });

  it.effect("reads the run by its tool call in the parent task", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      writeBobMessages(databasePath, [
        ["parent", subagentRun("call-other", [{ role: "user", content: "Other run." }])],
        ["parent", subagentRun("call-run", RUN)],
        ["another-task", subagentRun("call-run", [{ role: "user", content: "Wrong task." }])],
      ]);
      const transcript = yield* readBobSubagentTranscript(databasePath, "parent", "call-run");
      expect(transcript.entries[0]).toEqual({
        _tag: "prompt",
        text: "List the folder and write REPORT.md.",
      });
      expect(transcript.entries).toHaveLength(4);
    }),
  );

  it.effect("is empty when the run is missing, malformed or unreadable", () =>
    Effect.gen(function* () {
      const databasePath = yield* makeDatabasePath();
      writeBobMessages(databasePath, [
        ["parent", "{not json"],
        ["parent", { toolUsage: { signature: { id: "call-bare" } } }],
      ]);
      for (const toolCallId of ["call-missing", "call-bare"]) {
        expect(yield* readBobSubagentTranscript(databasePath, "parent", toolCallId)).toEqual({
          entries: [],
        });
      }
      expect(
        yield* readBobSubagentTranscript(`${databasePath}.missing`, "parent", "call-run"),
      ).toEqual({ entries: [] });
    }),
  );
});
