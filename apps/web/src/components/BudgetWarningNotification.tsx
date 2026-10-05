import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useClientSettings, usePrimarySettings } from "../hooks/useSettings";
import { environmentPresentations } from "../state/presentation";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import {
  budgetWarningText,
  collectBudgetWarnings,
  takeUnshownBudgetWarnings,
} from "./usage/budgetWarnings";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Warns once on this device when a provider's budget, such as a Bob team's monthly Bobcoins,
 * passes 80% and again 95% used: a toast, and under the thread notification setting a sound and
 * a system notification while T3 Code is in the background.
 */
export function BudgetWarningNotification() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  // A new read of the limits, which lands at least after every turn that spends, moves `now`.
  const warnings = useMemo(() => collectBudgetWarnings(presentations, Date.now()), [presentations]);

  useEffect(() => {
    const openUsage = () => void navigate({ to: "/usage" });
    for (const warning of takeUnshownBudgetWarnings(warnings)) {
      const { title, body } = budgetWarningText(warning, timestampFormat, Date.now());
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title,
          description: body,
          timeout: 0,
          actionProps: { children: "View usage", onClick: openUsage },
          actionVariant: "outline",
        }),
      );
      // As for threads, the sound follows the notification setting, not the platform's.
      if (hasNotificationSound(mode)) void playNotificationSound("input", () => true);
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        continue;
      }
      try {
        const notification = new Notification(title, {
          body,
          tag: `budget:${warning.key}`,
          silent: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          openUsage();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [warnings, mode, timestampFormat, navigate]);

  return null;
}
