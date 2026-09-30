import { CheckInRepeatLimitHours, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const isRepeatLimit = Schema.is(CheckInRepeatLimitHours);

function RepeatLimitInput({
  value,
  mixed,
  disabled,
  onCommit,
}: {
  value: number;
  mixed: boolean;
  disabled: boolean;
  onCommit: (hours: number) => void;
}) {
  // Committed on blur or Enter rather than per keystroke: typing "48" passes through "4",
  // which is also a legal limit.
  return (
    <div className="flex items-center gap-2">
      <NumberField
        value={mixed ? null : value}
        min={1}
        max={720}
        size="sm"
        className="w-32"
        disabled={disabled}
        onValueCommitted={(next) => {
          if (next === null) return;
          const hours = Math.round(next);
          if (isRepeatLimit(hours) && (mixed || hours !== value)) onCommit(hours);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label="Fewer hours before a repeating check-in stops" />
          <NumberFieldInput
            placeholder={mixed ? "Mixed" : undefined}
            aria-label="Hours before a repeating check-in stops"
          />
          <NumberFieldIncrement aria-label="More hours before a repeating check-in stops" />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">hours</span>
    </div>
  );
}

/**
 * Whether agents may schedule check-ins, how long a repeating one runs, and whether agents get
 * the agent-threads tools. All follow the settings scope, so a project can differ from its
 * environment.
 */
export function AgentCheckInsSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed(["enableAgentCheckIns"]);
  const mixedLimit = useScopedSettingsMixed(["checkInRepeatLimitHours"]);
  const mixedThreads = useScopedSettingsMixed(["enableAgentThreads"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  // A server without check-ins drops these keys, so an edit there would snap back.
  const supported = connectedEnvironments.every(
    (environment) => environment.serverConfig?.environment.capabilities.threadCheckIns === true,
  );
  const threadsSupported = connectedEnvironments.every(
    (environment) => environment.serverConfig?.environment.capabilities.agentThreads === true,
  );
  return (
    <SettingsSection id="check-ins" title="Check-ins, background commands and agent threads">
      <SettingsUnavailableGroup
        message={
          supported ? undefined : "A selected environment's server does not support check-ins."
        }
      >
        <SettingsRow
          serverScoped
          settingKeys={["enableAgentCheckIns"]}
          mixed={mixedEnabled}
          id={searchableSetting("agent-check-ins").id}
          title="Agent check-ins"
          description={
            isProjectScope
              ? "Let agents in this project schedule a message back into their thread later, and run long commands in the background that tell them when they end. Each message is a turn. Background commands need Full access and tmux. Applies when the agent session next starts."
              : "Let agents schedule a message back into their thread later, and run long commands in the background that tell them when they end. Each message is a turn. Background commands need Full access and tmux. Projects can override it."
          }
          resetAction={
            supported &&
            settings.enableAgentCheckIns !== DEFAULT_SERVER_SETTINGS.enableAgentCheckIns ? (
              <SettingResetButton
                label="check-ins"
                onClick={() =>
                  updateSettings({
                    enableAgentCheckIns: DEFAULT_SERVER_SETTINGS.enableAgentCheckIns,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              aria-label="Agent check-ins"
              mixed={mixedEnabled}
              disabled={!supported}
              checked={mixedEnabled ? false : settings.enableAgentCheckIns}
              onCheckedChange={(enabled) => updateSettings({ enableAgentCheckIns: enabled })}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["checkInRepeatLimitHours"]}
          mixed={mixedLimit}
          id={searchableSetting("check-in-repeat-limit").id}
          title="Repeating check-ins end after"
          description="Hours a repeating check-in, or a background command's status updates, keep going before they stop on their own. The agent can schedule another check-in."
          resetAction={
            supported &&
            settings.checkInRepeatLimitHours !== DEFAULT_SERVER_SETTINGS.checkInRepeatLimitHours ? (
              <SettingResetButton
                label="check-in limit"
                onClick={() =>
                  updateSettings({
                    checkInRepeatLimitHours: DEFAULT_SERVER_SETTINGS.checkInRepeatLimitHours,
                  })
                }
              />
            ) : null
          }
          control={
            <RepeatLimitInput
              value={settings.checkInRepeatLimitHours}
              mixed={mixedLimit}
              disabled={!supported}
              onCommit={(hours) => updateSettings({ checkInRepeatLimitHours: hours })}
            />
          }
        />
      </SettingsUnavailableGroup>
      <SettingsUnavailableGroup
        message={
          threadsSupported
            ? undefined
            : "A selected environment's server does not support agent threads."
        }
      >
        <SettingsRow
          serverScoped
          settingKeys={["enableAgentThreads"]}
          mixed={mixedThreads}
          id={searchableSetting("agent-threads").id}
          title="Agent threads"
          description={
            isProjectScope
              ? "Let agents in this project list and read your threads, start new threads on any enabled provider, message other threads, and wait for one to finish. Each started thread and message is a turn. Applies when the agent session next starts."
              : "Let agents list and read your threads, start new threads on any enabled provider, message other threads, and wait for one to finish. Each started thread and message is a turn. Projects can override it."
          }
          resetAction={
            threadsSupported &&
            settings.enableAgentThreads !== DEFAULT_SERVER_SETTINGS.enableAgentThreads ? (
              <SettingResetButton
                label="agent threads"
                onClick={() =>
                  updateSettings({
                    enableAgentThreads: DEFAULT_SERVER_SETTINGS.enableAgentThreads,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              aria-label="Agent threads"
              mixed={mixedThreads}
              disabled={!threadsSupported}
              checked={mixedThreads ? false : settings.enableAgentThreads}
              onCheckedChange={(enabled) => updateSettings({ enableAgentThreads: enabled })}
            />
          }
        />
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
