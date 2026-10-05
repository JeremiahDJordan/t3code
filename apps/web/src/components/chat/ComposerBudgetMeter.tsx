import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatUsageCredits } from "@t3tools/shared/usageFormat";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";
import { CoinsIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The composer's budget meter, left of the context meter: a ring filled to the share of a
 * provider's allowance left, such as Bob's monthly Bobcoins, with a coin inside to tell it from
 * the context ring. Hovering shows the amounts and the reset; `onOpenLimits` adds a way to the
 * full `/usage-limits` view.
 */
export function ComposerBudgetMeter(props: {
  window: ServerProviderUsageWindow;
  onOpenLimits?: (() => void) | undefined;
}) {
  const { window, onOpenLimits } = props;
  const remaining = remainingPercent(window);
  // The Limits bars fill with what is left, so the ring runs down as it is spent. It turns
  // amber and then red where T3 warns that the budget runs low, at 80% and 95% used.
  const color =
    remaining <= 5
      ? "var(--color-error)"
      : remaining <= 20
        ? "var(--color-warning)"
        : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const title = window.amount ? `${window.label} ${window.amount.unit}` : window.label;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onOpenLimits ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={`${title}: ${remaining}% left`}
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={RADIUS}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={RADIUS}
                  fill="none"
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - remaining / 100)}
                />
              </svg>
              <CoinsIcon aria-hidden="true" className="size-2.5 text-muted-foreground" />
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <BudgetDetails
          window={window}
          title={title}
          remaining={remaining}
          color={color}
          onOpenLimits={onOpenLimits}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Mounted only while the popover is open, so each hover reads the countdown afresh. */
function BudgetDetails(props: {
  window: ServerProviderUsageWindow;
  title: string;
  remaining: number;
  color: string;
  onOpenLimits: (() => void) | undefined;
}) {
  const { window, title, remaining, color, onOpenLimits } = props;
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [now] = useState(() => Date.now());
  const resetsIn = formatResetsIn(window, now);
  const rows = [
    ...(window.amount
      ? [
          {
            label: "Used",
            value: `${formatUsageCredits(window.amount.used)} of ${formatUsageCredits(window.amount.limit)}`,
          },
          {
            label: "Left",
            value: formatUsageCredits(Math.max(0, window.amount.limit - window.amount.used)),
          },
        ]
      : []),
    ...(window.resetsAt
      ? [
          {
            label: "Resets",
            value: `${formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}${
              resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""
            }`,
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2 p-(--floating-content-inset)">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">{title}</div>
        <div className="text-secondary-label text-2xs tabular-nums">{remaining}% left</div>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-label={`${title} left`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3 text-2xs leading-4">
          <span className="text-secondary-label">{row.label}</span>
          <span className="font-medium tabular-nums text-secondary-label">{row.value}</span>
        </div>
      ))}
      {onOpenLimits ? (
        <Button
          size="xs"
          variant="outline"
          className="mt-1 w-full justify-center"
          onClick={onOpenLimits}
        >
          <GaugeIcon aria-hidden="true" />
          Show usage limits
        </Button>
      ) : null}
    </div>
  );
}
