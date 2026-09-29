import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadBackgroundCommand,
  ThreadCheckIn,
  ThreadId,
} from "@t3tools/contracts";
import { AlarmClockIcon, SquareTerminalIcon } from "lucide-react";
import { useMemo } from "react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { usePrimarySettings } from "../../hooks/useSettings";
import { checkInEnvironment } from "../../state/checkIns";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { formatShortTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function everyLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** `every 20m · next 2:40 PM`, `at 2:40 PM`, or that it waits for the turn to end. */
function scheduleLabel(
  checkIn: ThreadCheckIn,
  timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1],
) {
  if (checkIn.dueSince !== null) return "due; waits for the agent to finish";
  const at = formatUpcomingTimestamp(checkIn.nextAt, timestampFormat);
  return checkIn.repeatEveryMinutes === null
    ? `at ${at}`
    : `every ${everyLabel(checkIn.repeatEveryMinutes)} · next ${at}`;
}

/** Tells the user why a check-in or command action failed; an interrupted one stays quiet. */
function toastFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

/**
 * The check-ins the agent scheduled in this thread, above the composer, each with a way to cancel
 * it. Nothing shows on servers without check-ins or while the thread has none.
 */
export function useCheckInBannerItem(
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
  supported: boolean,
): ComposerBannerStackItem | null {
  const query = useEnvironmentQuery(
    thread && supported
      ? checkInEnvironment.threadCheckIns({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  const cancel = useAtomCommand(checkInEnvironment.cancel);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const checkIns = query.data;

  return useMemo(() => {
    if (!thread || !checkIns || checkIns.length === 0) return null;
    const cancelButton = (checkIn: ThreadCheckIn) => (
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Cancel check-in: ${checkIn.note}`}
        onClick={() =>
          void cancel({
            environmentId: thread.environmentId,
            input: { checkInId: checkIn.id },
          }).then((result) => toastFailure(result, "Could not cancel the check-in"))
        }
      >
        Cancel
      </Button>
    );
    const [only] = checkIns;
    if (checkIns.length === 1 && only) {
      return {
        id: `check-ins:${thread.threadId}`,
        variant: "info",
        compact: true,
        priority: "notice",
        icon: <AlarmClockIcon />,
        // The schedule leads: agents write long notes, and the description is what truncates.
        title: `Check-in ${scheduleLabel(only, timestampFormat)}`,
        description: only.note,
        actions: cancelButton(only),
      };
    }
    return {
      id: `check-ins:${thread.threadId}`,
      variant: "info",
      priority: "notice",
      icon: <AlarmClockIcon />,
      title: `${checkIns.length} check-ins`,
      children: (
        <ComposerBanner.Body className="flex flex-col gap-1 pb-1.5">
          {checkIns.map((checkIn) => (
            <div key={checkIn.id} className="flex min-w-0 items-center gap-2 text-xs">
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 flex-1 truncate text-foreground" />}
                >
                  {checkIn.note}
                </TooltipTrigger>
                <TooltipPopup side="top">{checkIn.note}</TooltipPopup>
              </Tooltip>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {scheduleLabel(checkIn, timestampFormat)}
              </span>
              {cancelButton(checkIn)}
            </div>
          ))}
        </ComposerBanner.Body>
      ),
    };
  }, [cancel, checkIns, thread, timestampFormat]);
}

function commandStatusLabel(
  command: ThreadBackgroundCommand,
  timestampFormat: Parameters<typeof formatShortTimestamp>[1],
): string {
  if (command.status !== "running") {
    const how =
      command.status === "lost"
        ? "Ended, exit unknown"
        : command.status === "stopped"
          ? "Stopped"
          : `Finished (${command.exitStatus ?? "exit unknown"})`;
    return `${how} · telling the agent`;
  }
  const since = `Running since ${formatShortTimestamp(command.startedAt, timestampFormat)}`;
  const checkIns =
    command.statusEveryMinutes === null
      ? ""
      : ` · status updates every ${everyLabel(command.statusEveryMinutes)}`;
  return `${since}${checkIns}${command.stopRequestedBy === null ? "" : " · stopping"}`;
}

/**
 * The agent's background commands in this thread, above the composer: each with a way to watch
 * it in a terminal and to stop it. Nothing shows on servers without them or while none run.
 */
export function useBackgroundCommandBannerItem(
  thread: ScopedThreadRef | null,
  supported: boolean,
): ComposerBannerStackItem | null {
  const query = useEnvironmentQuery(
    thread && supported
      ? checkInEnvironment.threadBackgroundCommands({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  const stop = useAtomCommand(checkInEnvironment.stopBackgroundCommand);
  const openTerminal = useAtomCommand(checkInEnvironment.openBackgroundCommandTerminal);
  const ensureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const commands = query.data;

  return useMemo(() => {
    if (!thread || !commands || commands.length === 0) return null;
    const actions = (command: ThreadBackgroundCommand) =>
      command.status === "running" ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Open a terminal on ${command.command}`}
            onClick={() =>
              void openTerminal({
                environmentId: thread.environmentId,
                input: { backgroundCommandId: command.id },
              }).then((result) => {
                if (result._tag === "Success") {
                  ensureTerminal(thread, result.value.terminalId, { open: true, active: true });
                } else {
                  toastFailure(result, "Could not open a terminal on the command");
                }
              })
            }
          >
            Terminal
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Stop ${command.command}`}
            disabled={command.stopRequestedBy !== null}
            onClick={() =>
              void stop({
                environmentId: thread.environmentId,
                input: { backgroundCommandId: command.id },
              }).then((result) => toastFailure(result, "Could not stop the command"))
            }
          >
            Stop
          </Button>
        </>
      ) : null;
    const [only] = commands;
    if (commands.length === 1 && only) {
      return {
        id: `background-commands:${thread.threadId}`,
        variant: "info",
        compact: true,
        priority: "notice",
        icon: <SquareTerminalIcon />,
        // Capped, so a long command leaves room for its status.
        title: (
          <Tooltip>
            <TooltipTrigger render={<code className="block max-w-[32ch] truncate" />}>
              {only.command}
            </TooltipTrigger>
            <TooltipPopup side="top" variant="code">
              {only.command}
            </TooltipPopup>
          </Tooltip>
        ),
        description: commandStatusLabel(only, timestampFormat),
        actions: actions(only),
      };
    }
    return {
      id: `background-commands:${thread.threadId}`,
      variant: "info",
      priority: "notice",
      icon: <SquareTerminalIcon />,
      title: `${commands.length} background commands`,
      children: (
        <ComposerBanner.Body className="flex flex-col gap-1 pb-1.5">
          {commands.map((command) => (
            <div key={command.id} className="flex min-w-0 items-center gap-2 text-xs">
              <Tooltip>
                <TooltipTrigger
                  render={<code className="min-w-[8ch] flex-1 truncate text-foreground" />}
                >
                  {command.command}
                </TooltipTrigger>
                <TooltipPopup side="top" variant="code">
                  {command.command}
                </TooltipPopup>
              </Tooltip>
              {/* Shrinks after the command's minimum so the actions stay on screen. */}
              <span className="min-w-0 truncate text-muted-foreground tabular-nums">
                {commandStatusLabel(command, timestampFormat)}
              </span>
              {actions(command)}
            </div>
          ))}
        </ComposerBanner.Body>
      ),
    };
  }, [commands, ensureTerminal, openTerminal, stop, thread, timestampFormat]);
}
