import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo, useState } from "react";
import { ChevronDownIcon, EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    optionId?: string,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  // Choices that share a decision, told apart by their ids, show as one split button.
  const choices = options.filter((option) => option.optionId !== undefined);
  const plain = options.filter((option) => option.optionId === undefined);
  const primaryOptions = plain.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = plain.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );
  const respond = (option: ProviderApprovalOption) =>
    void onRespondToApproval(requestId, option.decision, option.optionId);

  return (
    <>
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={disabled || isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => {
              if (!disabled && !isResponding) respond(option);
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        const shown = option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
        // The split button sits beside Approve, as another way to approve.
        return option.decision === "accept" && choices.length > 0
          ? [
              <ApprovalChoiceButton
                key={`${requestId}:choices`}
                choices={choices}
                disabled={isResponding || !canRespond}
                onChoose={respond}
              />,
              shown,
            ]
          : shown;
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding) respond(option);
                  }}
                  variant="ghost"
                  className="mb-1 last:mb-0"
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});

/** Characters kept at a choice's end, where its label says how it differs from the others. */
const CHOICE_LABEL_TAIL = 18;

/**
 * Choices that share a decision as one button, like a merge button: it acts on the selected
 * choice, the first unless the menu picked another, and the provider lists first the one the
 * user picked last time.
 */
const ApprovalChoiceButton = memo(function ApprovalChoiceButton({
  choices,
  disabled,
  onChoose,
}: {
  choices: ReadonlyArray<ProviderApprovalOption>;
  disabled: boolean;
  onChoose: (option: ProviderApprovalOption) => void;
}) {
  const [selectedId, setSelectedId] = useState(choices[0]?.optionId);
  const selected = choices.find((option) => option.optionId === selectedId) ?? choices[0];
  if (selected === undefined) return null;
  const main = (
    <Button
      size="xs"
      variant="outline"
      disabled={disabled}
      aria-description={selected.warning}
      onClick={() => onChoose(selected)}
    >
      {selected.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
      <MiddleTruncate
        value={selected.label}
        tail={CHOICE_LABEL_TAIL}
        showTitle={false}
        className="max-w-52"
      />
    </Button>
  );
  return (
    <Group>
      <Tooltip>
        <TooltipTrigger render={main} />
        <TooltipPopup side="top">
          <span className="block max-w-72">{selected.label}</span>
          {selected.warning ? (
            <span className="block max-w-72 text-muted-foreground">{selected.warning}</span>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={<Button size="icon-xs" variant="outline" aria-label="Choose where it applies" />}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
          <MenuRadioGroup value={selected.optionId} onValueChange={setSelectedId}>
            {choices.map((option) => (
              <MenuRadioItem key={option.optionId} value={option.optionId} closeOnClick>
                <span className="whitespace-normal wrap-break-word">{option.label}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </Group>
  );
});
