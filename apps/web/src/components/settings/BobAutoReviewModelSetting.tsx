import { type EnvironmentId, ModelSelection, type ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);

const configRecord = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

/** The Bob instance's Auto reviewer, `apple` when its config leaves the default. */
export function readBobAutoReviewer(config: unknown): string {
  const reviewer = configRecord(config).autoReviewer;
  return typeof reviewer === "string" && reviewer.length > 0 ? reviewer : "apple";
}

export function readBobAutoReviewModelSelection(config: unknown): ModelSelection | undefined {
  return Option.getOrUndefined(decodeModelSelection(configRecord(config).autoReviewModelSelection));
}

/** The config with the reviewer's model set, or without one to follow text generation. */
export function withBobAutoReviewModelSelection(
  config: unknown,
  selection: ModelSelection | undefined,
): Record<string, unknown> {
  const { autoReviewModelSelection: _previous, ...rest } = configRecord(config);
  return selection === undefined ? rest : { ...rest, autoReviewModelSelection: selection };
}

/**
 * The model a Bob instance's Auto reviewer asks when the reviewer is a provider's model. Unset,
 * it follows the text generation model; Bob itself is a choice, and runs as a Bob of its own.
 */
export function BobAutoReviewModelSetting(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection | undefined;
  readonly onChange: (selection: ModelSelection | undefined) => void;
}) {
  const providers = props.serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), props.settings, null),
  );
  const active = props.selection ?? resolveAppModelSelectionState(props.settings, providers);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    props.settings,
    providers,
    active.instanceId,
    active.model,
  );
  return (
    <SettingsRow
      title="Reviewer's model"
      description="For a provider's model as the reviewer. Until you choose one, the text generation model."
      resetAction={
        props.selection === undefined ? undefined : (
          <SettingResetButton label="reviewer's model" onClick={() => props.onChange(undefined)} />
        )
      }
      control={
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={active.instanceId}
          model={active.model}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel="Reviewer's model"
          onInstanceModelChange={(instanceId, model) =>
            props.onChange(createModelSelection(instanceId, model))
          }
        />
      }
    />
  );
}
