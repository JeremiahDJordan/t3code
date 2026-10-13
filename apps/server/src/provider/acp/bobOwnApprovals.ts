/** The commands Bob approves on its own by default, which only read. */
const BOB_DEFAULT_APPROVED_COMMANDS = new Set([
  "cat",
  "git diff",
  "git log",
  "git rev-parse",
  "git show",
  "git status",
  "grep",
  "head",
  "tail",
  "ls",
  "sort",
  "wc",
  "which",
  "du",
  "df",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function listed(items: ReadonlyArray<string>): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What Bob's own approval settings, the `approval` section of `~/.bob/settings/settings.json`, let
 * it do without asking T3, beyond its defaults: Bob 2.0.6 applies them over ACP before any
 * request reaches T3, so Supervised and Auto never see those calls. Its default reads and
 * read-only commands are left out, since T3 would allow them anyway.
 */
export function bobOwnApprovals(settings: unknown): ReadonlyArray<string> {
  const approval = record(record(settings)?.approval) ?? {};
  if (approval.autoApprovalEnabled === false) return [];
  const groups = Array.isArray(approval.allowed_permissions)
    ? strings(approval.allowed_permissions)
    : ["read"];
  const found: Array<string> = [];
  if (groups.includes("edit")) found.push("edit files");
  if (groups.includes("execute")) {
    const executors = Array.isArray(approval.allowedExecutors)
      ? approval.allowedExecutors.map(record)
      : undefined;
    const commands =
      executors === undefined
        ? []
        : strings(
            executors.find((executor) => executor?.toolId === "execute_command")?.approvedCommands,
          ).filter((command) => !BOB_DEFAULT_APPROVED_COMMANDS.has(command.trim()));
    if (commands.length > 0) {
      const named = commands.slice(0, 3);
      found.push(
        `run ${listed(commands.length > 3 ? [...named, `${commands.length - 3} more command${commands.length === 4 ? "" : "s"}`] : named)}`,
      );
    }
  }
  if (groups.includes("mcp")) found.push("use MCP tools");
  if (approval.outsideWorkspaceAllowed === true) found.push("work outside the project");
  return found;
}

/** The notice a Supervised or Auto turn shows when Bob's own settings approve calls, or none. */
export function bobOwnApprovalsNotice(settings: unknown): string | undefined {
  const found = bobOwnApprovals(settings);
  if (found.length === 0) return undefined;
  return (
    `Bob's own approval settings let it ${listed(found)} without asking T3, so T3's rules never ` +
    "see those calls; its commands still run in T3's sandbox, where any that need the network or " +
    'your credentials fail. To have Bob ask T3 about everything, set "autoApprovalEnabled" to ' +
    'false under "approval" in ~/.bob/settings/settings.json.'
  );
}
