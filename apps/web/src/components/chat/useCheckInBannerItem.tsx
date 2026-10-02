import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadBackgroundCommand,
  ThreadCheckIn,
  ThreadId,
} from "@t3tools/contracts";
import {
  backgroundCommandStatusLabel,
  canMuteBackgroundCommand,
  checkInScheduleLabel,
  checkInTitle,
  waitedThreadName,
} from "@t3tools/client-runtime/state/checkIns";
import { Link } from "@tanstack/react-router";
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
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** `every 20m · next 2:40 PM`, `at 2:40 PM`, `stops waiting 4:00 PM`, or that it is due. */
function scheduleLabel(
  checkIn: ThreadCheckIn,
  timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1],
) {
  return checkInScheduleLabel(checkIn, formatUpcomingTimestamp(checkIn.nextAt, timestampFormat));
}

/**
 * A check-in's truncating title with its full text in a tooltip: the agent's note, or for a wait,
 * the thread it waits on as a link. Waits reach only threads in the same environment.
 */
function CheckInSubject({
  checkIn,
  environmentId,
  className,
}: {
  checkIn: ThreadCheckIn;
  environmentId: EnvironmentId;
  className: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>
        {checkIn.waitsFor ? (
          <>
            When{" "}
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({
                environmentId,
                threadId: checkIn.waitsFor.threadId,
              })}
              className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:decoration-solid"
            >
              {waitedThreadName(checkIn.waitsFor)}
            </Link>{" "}
            finishes
          </>
        ) : (
          checkIn.note
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{checkInTitle(checkIn)}</TooltipPopup>
    </Tooltip>
  );
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
        aria-label={`Cancel check-in: ${checkInTitle(checkIn)}`}
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
      const schedule = scheduleLabel(only, timestampFormat);
      return {
        id: `check-ins:${thread.threadId}`,
        variant: "info",
        compact: true,
        priority: "notice",
        icon: <AlarmClockIcon />,
        ...(only.waitsFor
          ? {
              title: (
                <CheckInSubject
                  checkIn={only}
                  environmentId={thread.environmentId}
                  className="block truncate"
                />
              ),
              description: `${schedule.charAt(0).toUpperCase()}${schedule.slice(1)}`,
            }
          : // The schedule leads: agents write long notes, and the description is what truncates.
            { title: `Check-in ${schedule}`, description: only.note }),
        actions: cancelButton(only),
      };
    }
    return {
      id: `check-ins:${thread.threadId}`,
      variant: "info",
      priority: "notice",
      icon: <AlarmClockIcon />,
      title: `${checkIns.length} check-ins`,
      // Scrolls, so a fan-out's many waits leave the heading and the conversation in view.
      children: (
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="flex flex-col gap-1 pb-1.5">
            {checkIns.map((checkIn) => (
              <div key={checkIn.id} className="flex min-w-0 items-center gap-2 text-xs">
                <CheckInSubject
                  checkIn={checkIn}
                  environmentId={thread.environmentId}
                  className="min-w-0 flex-1 truncate text-foreground"
                />
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {scheduleLabel(checkIn, timestampFormat)}
                </span>
                {cancelButton(checkIn)}
              </div>
            ))}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      ),
    };
  }, [cancel, checkIns, thread, timestampFormat]);
}

function commandStatusLabel(
  command: ThreadBackgroundCommand,
  timestampFormat: Parameters<typeof formatDayAwareTimestamp>[1],
): string {
  return backgroundCommandStatusLabel(
    command,
    formatDayAwareTimestamp(command.startedAt, timestampFormat),
  );
}

/**
 * The agent's background commands in this thread, above the composer: each with a way to watch
 * it in a terminal, to mute the updates it sends while it runs, and to stop it. Nothing shows on servers without them or while none run.
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
  const setMuted = useAtomCommand(checkInEnvironment.setBackgroundCommandMuted);
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
          {canMuteBackgroundCommand(command) ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${command.muted ? "Unmute" : "Mute"} ${command.command}`}
              title={
                command.muted
                  ? "Send the agent this command's status updates and matching lines again"
                  : "Stop sending the agent this command's status updates and matching lines; it still hears when it ends"
              }
              onClick={() =>
                void setMuted({
                  environmentId: thread.environmentId,
                  input: { backgroundCommandId: command.id, muted: !command.muted },
                }).then((result) =>
                  toastFailure(
                    result,
                    command.muted ? "Could not unmute the command" : "Could not mute the command",
                  ),
                )
              }
            >
              {command.muted ? "Unmute" : "Mute"}
            </Button>
          ) : null}
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
  }, [commands, ensureTerminal, openTerminal, setMuted, stop, thread, timestampFormat]);
}
