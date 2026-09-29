import type { EnvironmentId, ThreadCheckIn, ThreadId } from "@t3tools/contracts";
import { AlarmClockIcon } from "lucide-react";
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
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function everyLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** `Every 20m · next 2:40 PM`, `At 2:40 PM`, or that it waits for the turn to end. */
function scheduleLabel(checkIn: ThreadCheckIn, timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1]) {
  if (checkIn.dueSince !== null) return "Due; waits for the agent to finish";
  const at = formatUpcomingTimestamp(checkIn.nextAt, timestampFormat);
  return checkIn.repeatEveryMinutes === null
    ? `At ${at}`
    : `Every ${everyLabel(checkIn.repeatEveryMinutes)} · next ${at}`;
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
        title: `Check-in: ${only.note}`,
        description: scheduleLabel(only, timestampFormat),
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
