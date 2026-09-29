import type { EnvironmentId, ThreadCheckIn, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { checkInEnvironment } from "../../state/checkIns";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

function everyLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** `Every 20m · next 2:40 PM`, `At 2:40 PM`, or that it waits for the turn to end. */
function scheduleLabel(checkIn: ThreadCheckIn): string {
  if (checkIn.dueSince !== null) return "Due; waits for the agent to finish";
  const at = new Date(checkIn.nextAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return checkIn.repeatEveryMinutes === null
    ? `At ${at}`
    : `Every ${everyLabel(checkIn.repeatEveryMinutes)} · next ${at}`;
}

/**
 * The check-ins the agent scheduled in this thread, above the composer, each with Cancel.
 * Renders nothing on servers without check-ins or while the thread has none.
 */
export function ThreadCheckIns(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly supported: boolean;
}) {
  const query = useEnvironmentQuery(
    props.supported
      ? checkInEnvironment.threadCheckIns({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const cancel = useAtomCommand(checkInEnvironment.cancel);
  const checkIns = query.data ?? [];
  if (checkIns.length === 0) return null;
  return (
    <View className="shrink-0 px-4 pb-3">
      <View className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
        {checkIns.map((checkIn) => (
          <View key={checkIn.id} className="flex-row items-center gap-3">
            <SymbolView
              name="clock"
              size={16}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-medium text-sm" numberOfLines={1}>
                {checkIn.note}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {scheduleLabel(checkIn)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Cancel check-in: ${checkIn.note}`}
              className="rounded-full border border-border bg-background px-3 py-1.5"
              onPress={() =>
                void cancel({
                  environmentId: props.environmentId,
                  input: { checkInId: checkIn.id },
                })
              }
            >
              <Text className="font-t3-medium text-xs">Cancel</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}
