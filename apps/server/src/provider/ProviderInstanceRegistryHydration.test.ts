import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  WORKFLOW_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("never builds an instance with the workflow engine's reserved id", () => {
    const configured = {
      driver: ProviderDriverKind.make("codex"),
      displayName: "Hand-edited",
    };
    const map = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [WORKFLOW_PROVIDER_INSTANCE_ID]: configured,
        [ProviderInstanceId.make("codex_work")]: configured,
      },
    });
    expect(Object.keys(map)).not.toContain(WORKFLOW_PROVIDER_INSTANCE_ID);
    expect(Object.keys(map)).toContain("codex_work");
  });
});
