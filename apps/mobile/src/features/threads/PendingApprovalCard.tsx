import { RequestActionButton } from "./RequestActionButton";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    optionId?: string,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  // Choices that share a decision, told apart by their ids, show as one split button.
  const choices = options.filter((option) => option.optionId !== undefined);
  const plain = options.filter((option) => option.optionId === undefined);
  const [selectedId, setSelectedId] = useState(choices[0]?.optionId);
  const selected = choices.find((option) => option.optionId === selectedId) ?? choices[0];
  const warning = (selected?.warning ? selected : plain.find((option) => option.warning))?.warning;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  const canRespond = props.approval.responseCapability === "live";
  const disabled =
    !canRespond ||
    !props.canOperateThread ||
    props.respondingApprovalId === props.approval.requestId;
  const respond = (option: ProviderApprovalOption) =>
    void props.onRespond(props.approval.requestId, option.decision, option.optionId);
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-adaptive-neutral-600-400">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {plain.map((option) => (
          <RequestActionButton
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled}
            onPress={() => respond(option)}
          />
        ))}
      </View>
      {selected ? (
        // Like a merge button: it acts on the selected choice, which the menu changes, and the
        // provider lists first the one the user picked last time.
        <View className="flex-row items-stretch gap-1">
          <View className="flex-1">
            <RequestActionButton
              label={selected.label}
              tone="secondary"
              disabled={disabled}
              onPress={() => respond(selected)}
            />
          </View>
          <ControlPillMenu
            actions={choices.map((option) => ({
              id: option.optionId ?? option.label,
              title: option.label,
              state: option.optionId === selected.optionId ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => setSelectedId(nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose where it applies"
              disabled={disabled}
              className="items-center justify-center rounded-[14px] bg-subtle-strong px-3 active:opacity-70 disabled:opacity-50"
            >
              <SymbolView
                name="chevron.down"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </Pressable>
          </ControlPillMenu>
        </View>
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-adaptive-neutral-500-400">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
}
