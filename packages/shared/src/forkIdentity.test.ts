import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { codexAuthDeliveryUrl, readCodexAuthDelivery } from "./codexAuthHandoff.ts";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("codexAuthDeliveryUrl", () => {
  it("returns a desktop sign-in to Z6 Code's page, never T3 Code's", () => {
    const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
    authorization.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:54213/auth/callback",
      state: "a".repeat(43),
      code_challenge_method: "S256",
      code_challenge: "b".repeat(43),
    }).toString();
    const page = "z6code://app/settings/providers?instanceId=work-codex";
    const link = codexAuthDeliveryUrl(
      {
        authorizationUrl: authorization.toString(),
        returnUrl: page,
        environmentId: EnvironmentId.make("local"),
        instanceId: ProviderInstanceId.make("work-codex"),
        flowId: "flow-one",
      },
      `http://127.0.0.1:54213/auth/callback?state=${"a".repeat(43)}&code=one-time-code&client_id=oaiapp_test`,
    );
    expect(link.startsWith(`${page}#codex-auth=`)).toBe(true);
    expect(readCodexAuthDelivery(link)?.returnUrl).toBe(page);
  });
});

describe("providerAuthReturnUrl", () => {
  it("takes Z6 Code's desktop pages and not T3 Code's", () => {
    expect(providerAuthReturnUrl("z6code://app/settings/providers")).toBe(
      "z6code://app/settings/providers",
    );
    expect(providerAuthReturnUrl("t3code://app/settings/providers")).toBeUndefined();
  });
});
