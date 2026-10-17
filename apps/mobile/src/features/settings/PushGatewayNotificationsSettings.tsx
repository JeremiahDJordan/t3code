/**
 * Fork: Settings → Notifications when T3 Connect is off. Pushes come from each server that has
 * the owner's push gateway configured, so there is no account to sign in to: the phone needs
 * notification permission, and registers with every such server on its own.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { pushGatewayEnvironmentIds } from "../agent-awareness/pushGatewayRegistration";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
  updateAgentAwarenessRegistrationPreferences,
} from "../agent-awareness/remoteRegistration";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type PermissionStatus = "checking" | "enabled" | "disabled" | "unsupported";

export function PushGatewayNotificationsSettings() {
  const insets = useSafeAreaInsets();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const servers = useMemo(
    () =>
      pushGatewayEnvironmentIds(configs).map((environmentId) => ({
        environmentId,
        label: configs.get(environmentId)?.environment.label ?? environmentId,
      })),
    [configs],
  );
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const registration = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  const [permission, setPermission] = useState<PermissionStatus>("checking");
  const pushAvailable = supportsAgentAwarenessPush();
  const liveActivitiesEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;

  const refreshPermission = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setPermission("unsupported");
      return;
    }
    const result = await Notifications.getPermissionsAsync().catch(() => null);
    setPermission(result?.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshPermission();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]);

  const enableNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((granted) =>
            granted.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setPermission("enabled");
      return;
    }
    setPermission(result.value.type === "unsupported" ? "unsupported" : "disabled");
    if (result.value.type === "denied" && !result.value.canAskAgain) {
      Dialog.alert(
        "Notifications disabled",
        "Notifications were denied for this app. Open Settings to enable them.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    }
  }, []);

  const onNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void enableNotifications();
        return;
      }
      Dialog.alert("Disable notifications", "Open system Settings to turn notifications off.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ]);
    },
    [enableNotifications],
  );

  const onLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      savePreferences({ liveActivitiesEnabled: enabled });
      void runtime.runPromise(
        updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: enabled }).pipe(
          Effect.ignore,
        ),
      );
    },
    [savePreferences],
  );

  const noServers = servers.length === 0;
  const subtitle = !pushAvailable
    ? Platform.OS === "ios"
      ? "This build has no push. Personal Team builds can't receive it."
      : "Install a newer app build to enable notifications"
    : noServers
      ? "None of your servers has a push gateway configured"
      : registration === "failed"
        ? "Couldn't register with your servers yet"
        : undefined;

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Agent activity"
          footer="Each server sends pushes through your own push gateway. Servers without one send none."
        >
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={
              !pushAvailable ||
              noServers ||
              permission === "checking" ||
              permission === "unsupported"
            }
            {...(subtitle === undefined ? {} : { subtitle })}
            value={pushAvailable && permission === "enabled" && registration === "registered"}
            onValueChange={onNotificationsChange}
          />
          <SettingsSwitchRow
            icon="bolt.circle"
            label={Platform.OS === "android" ? "Ongoing Agent Activity" : "Live Activity Updates"}
            disabled={!pushAvailable || noServers || !AsyncResult.isSuccess(preferencesResult)}
            value={pushAvailable && liveActivitiesEnabled}
            onValueChange={onLiveActivitiesChange}
          />
        </SettingsSection>
        {noServers ? null : (
          <SettingsSection title="Servers that push">
            {servers.map((server) => (
              <SettingsRow key={server.environmentId} icon="server.rack" label={server.label} />
            ))}
          </SettingsSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
