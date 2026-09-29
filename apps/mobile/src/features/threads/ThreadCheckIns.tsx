import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  ThreadBackgroundCommand,
  ThreadCheckIn,
  ThreadId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
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

function commandStatusLabel(command: ThreadBackgroundCommand): string {
  if (command.status !== "running") {
    const how =
      command.status === "lost"
        ? "Ended, exit unknown"
        : command.status === "stopped"
          ? "Stopped"
          : `Finished (${command.exitStatus ?? "exit unknown"})`;
    return `${how} · telling the agent`;
  }
  const since = new Date(command.startedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const checkIns =
    command.statusEveryMinutes === null
      ? ""
      : ` · status updates every ${everyLabel(command.statusEveryMinutes)}`;
  return `Running since ${since}${checkIns}${command.stopRequestedBy === null ? "" : " · stopping"}`;
}

function RowAction(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      className="rounded-full border border-border bg-background px-3 py-1.5 disabled:opacity-50"
      onPress={props.onPress}
    >
      <Text className="font-t3-medium text-xs">{props.label}</Text>
    </Pressable>
  );
}

function Row(props: {
  readonly symbol: "clock" | "terminal";
  readonly title: string;
  readonly detail: string;
  readonly monospace?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <SymbolView
        name={props.symbol}
        size={16}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text
          className={props.monospace ? "font-mono text-sm" : "font-t3-medium text-sm"}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </Text>
      </View>
      {props.children}
    </View>
  );
}

/**
 * The agent's background commands and scheduled check-ins in this thread, above the composer.
 * Commands offer Terminal and Stop; check-ins offer Cancel. Renders nothing on servers without
 * them or while the thread has none.
 */
export function ThreadCheckIns(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly supported: boolean;
  readonly commandsSupported: boolean;
}) {
  const navigation = useNavigation();
  const checkInsQuery = useEnvironmentQuery(
    props.supported
      ? checkInEnvironment.threadCheckIns({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const commandsQuery = useEnvironmentQuery(
    props.commandsSupported
      ? checkInEnvironment.threadBackgroundCommands({
          environmentId: props.environmentId,
          input: { threadId: props.threadId },
        })
      : null,
  );
  const cancel = useAtomCommand(checkInEnvironment.cancel);
  const stop = useAtomCommand(checkInEnvironment.stopBackgroundCommand);
  const openTerminal = useAtomCommand(checkInEnvironment.openBackgroundCommandTerminal);
  const checkIns = checkInsQuery.data ?? [];
  const commands = commandsQuery.data ?? [];
  if (checkIns.length === 0 && commands.length === 0) return null;
  return (
    <View className="shrink-0 px-4 pb-3">
      <View className="gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
        {commands.map((command) => (
          <Row
            key={command.id}
            symbol="terminal"
            title={command.command}
            detail={commandStatusLabel(command)}
            monospace
          >
            {command.status === "running" ? (
              <>
                <RowAction
                  label="Terminal"
                  accessibilityLabel={`Open a terminal on ${command.command}`}
                  onPress={() =>
                    void openTerminal({
                      environmentId: props.environmentId,
                      input: { backgroundCommandId: command.id },
                    }).then((result) => {
                      if (result._tag !== "Success") return;
                      void navigation.navigate("ThreadTerminal", {
                        environmentId: String(props.environmentId),
                        threadId: String(props.threadId),
                        terminalId: result.value.terminalId,
                      });
                    })
                  }
                />
                <RowAction
                  label="Stop"
                  accessibilityLabel={`Stop ${command.command}`}
                  disabled={command.stopRequestedBy !== null}
                  onPress={() =>
                    void stop({
                      environmentId: props.environmentId,
                      input: { backgroundCommandId: command.id },
                    })
                  }
                />
              </>
            ) : null}
          </Row>
        ))}
        {checkIns.map((checkIn) => (
          <Row key={checkIn.id} symbol="clock" title={checkIn.note} detail={scheduleLabel(checkIn)}>
            <RowAction
              label="Cancel"
              accessibilityLabel={`Cancel check-in: ${checkIn.note}`}
              onPress={() =>
                void cancel({
                  environmentId: props.environmentId,
                  input: { checkInId: checkIn.id },
                })
              }
            />
          </Row>
        ))}
      </View>
    </View>
  );
}
