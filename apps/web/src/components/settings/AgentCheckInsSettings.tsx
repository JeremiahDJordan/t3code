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
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const isRepeatLimit = Schema.is(CheckInRepeatLimitHours);

function RepeatLimitInput({
  value,
  mixed,
  onCommit,
}: {
  value: number;
  mixed: boolean;
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
 * Whether agents may schedule check-ins, and how long a repeating one runs. Both follow the
 * settings scope, so a project can differ from its environment.
 */
export function AgentCheckInsSettings() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed(["enableAgentCheckIns"]);
  const mixedLimit = useScopedSettingsMixed(["checkInRepeatLimitHours"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsSection id="agent-check-ins" title="Check-ins">
      <SettingsRow
        serverScoped
        settingKeys={["enableAgentCheckIns"]}
        mixed={mixedEnabled}
        id={searchableSetting("agent-check-ins").id}
        title="Agent check-ins"
        description={
          isProjectScope
            ? "Let agents in this project schedule a message back into their thread later, to check on a long build or CI. Each check-in is a turn. Applies when the agent session next starts."
            : "Let agents schedule a message back into their thread later, to check on a long build or CI. Each check-in is a turn. Projects can override it."
        }
        resetAction={
          settings.enableAgentCheckIns !== DEFAULT_SERVER_SETTINGS.enableAgentCheckIns ? (
            <SettingResetButton
              label="check-ins"
              onClick={() =>
                updateSettings({ enableAgentCheckIns: DEFAULT_SERVER_SETTINGS.enableAgentCheckIns })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Agent check-ins"
            mixed={mixedEnabled}
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
        description="Hours a repeating check-in keeps going before it stops on its own. The agent can schedule another."
        resetAction={
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
            onCommit={(hours) => updateSettings({ checkInRepeatLimitHours: hours })}
          />
        }
      />
    </SettingsSection>
  );
}
