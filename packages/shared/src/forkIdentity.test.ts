import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { codexAuthDeliveryUrl, readCodexAuthDelivery } from "./codexAuthHandoff.ts";
import { desktopLinkToPage, desktopPageToLink } from "./forkIdentity.ts";

describe("desktop links", () => {
  it("sends a desktop page out on the fork's scheme and loads it back at the page's origin", () => {
    const page = "t3code://app/settings/providers?instanceId=work";
    expect(desktopPageToLink(page)).toBe("z6code://app/settings/providers?instanceId=work");
    expect(desktopLinkToPage(desktopPageToLink(page))).toBe(page);
    expect(desktopPageToLink("t3code-dev://app/welcome")).toBe("z6code-dev://app/welcome");
    expect(desktopPageToLink("https://app.example/settings")).toBe("https://app.example/settings");
  });
});

describe("codexAuthDeliveryUrl", () => {
  it("returns a desktop sign-in to Z6 Code, not T3 Code", () => {
    const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
    authorization.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:54213/auth/callback",
      state: "a".repeat(43),
      code_challenge_method: "S256",
      code_challenge: "b".repeat(43),
    }).toString();
    const page = "t3code://app/settings/providers?instanceId=work-codex";
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
    expect(link.startsWith(`${desktopPageToLink(page)}#codex-auth=`)).toBe(true);
    expect(link.startsWith("z6code://")).toBe(true);
    expect(readCodexAuthDelivery(desktopLinkToPage(link))?.returnUrl).toBe(page);
  });
});
