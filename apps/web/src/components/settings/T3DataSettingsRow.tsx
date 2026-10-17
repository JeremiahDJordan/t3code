import type { DesktopT3DataState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Z6 Code copies T3 Code's data on its first start and then leaves T3's folders alone. This row
 * shows whether they remain and removes them; the desktop asks to confirm and reports the result.
 */
export function T3DataSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.t3Data;
  const [state, setState] = useState<DesktopT3DataState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const remove = useCallback(() => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge
      .remove()
      .then(setState)
      .catch(() => undefined)
      .finally(() => setPending(false));
  }, [bridge, pending]);

  if (!bridge || !state || state.locations.length === 0) return null;
  const kept = state.lastCleanup?.kept ?? [];
  const description = [
    `Z6 Code copied its data from T3 Code and no longer uses ${state.locations.map((location) => location.path).join(" or ")}. Keep it while you still use T3 Code.`,
    kept.length > 0
      ? `The last cleanup kept ${kept.length === 1 ? "1 folder" : `${kept.length} folders`}: ${kept.map((item) => `${item.path} (${item.reason})`).join("; ")}.`
      : "",
  ]
    .filter((line) => line.length > 0)
    .join(" ");

  return (
    <SettingsRow
      {...searchableSetting("t3-data")}
      description={description}
      control={
        <Button size="sm" variant="outline" disabled={pending} onClick={remove}>
          Move to Trash
        </Button>
      }
    />
  );
}
