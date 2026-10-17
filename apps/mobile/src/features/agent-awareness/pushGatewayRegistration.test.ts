import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { type EnvironmentId, PUSH_GATEWAY_ANDROID_USER_ID } from "@t3tools/contracts";

import type { Preferences } from "../../persistence/mobile-preferences";
import { loadPreferences } from "../../persistence/imperative";
import { configureAndroidAgentNotifications } from "./androidNotifications";
import {
  __resetPushGatewayRegistrationsForTest,
  type PushGatewayTransport,
  pushGatewayRegistrationInput,
  registerDeviceWithPushGateways,
  registerLiveActivityWithPushGateways,
  setPushGatewayTransport,
  unregisterFromPushGateway,
} from "./pushGatewayRegistration";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  armAgentAwarenessLiveActivityForLocalWork,
  getAgentAwarenessRegistrationStatus,
  setAgentAwarenessRelayTokenProvider,
  startAgentAwarenessPushGateway,
} from "./remoteRegistration";

// The fork's default: T3 Connect is off, so push goes through each server's gateway.
vi.mock("@t3tools/shared/forkFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/forkFeatures")>()),
  T3_CONNECT_ENABLED: false,
}));

const mocks = vi.hoisted(() => ({
  configs: new Map<string, { environment: { capabilities: Record<string, unknown> } }>(),
  subscribers: [] as Array<(configs: unknown) => void>,
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
  startActivity: vi.fn(() => null),
  os: "ios" as "ios" | "android",
}));

vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: vi.fn(() => true),
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "1.0.0",
      ios: { bundleIdentifier: "com.example.z6" },
      android: { package: "com.example.z6.android" },
      extra: {},
    },
  },
}));
vi.mock("expo-widgets", () => ({}));
vi.mock("./agentLiveActivity", () => ({
  getAgentLiveActivities: () => [],
  startAgentLiveActivity: mocks.startActivity,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => mocks.configs,
    subscribe: (_atom: unknown, listener: (configs: unknown) => void) => {
      mocks.subscribers.push(listener);
      return () => {};
    },
  },
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environmentServerConfigsAtom"),
}));
vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() =>
    Promise.resolve({ type: mocks.os, data: mocks.os === "ios" ? "apns-token" : "fcm-token" }),
  ),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
    get Version() {
      return mocks.os === "ios" ? "18.0" : 34;
    },
  },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: unknown) =>
      new Promise((resolve) => mocks.pending.push({ operation, resolve })),
  },
}));
vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({ liveActivitiesEnabled: true })),
  loadAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve(null)),
  saveAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve()),
  clearAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve()),
}));

const GATEWAY = "env-gateway" as EnvironmentId;
const PLAIN = "env-plain" as EnvironmentId;

const fakeTransport = () => {
  const calls: Array<{
    readonly method: string;
    readonly environmentId: string;
    readonly input: unknown;
  }> = [];
  const answers = new Map<string, boolean>();
  const transport: PushGatewayTransport = {
    register: (environmentId, input) => {
      calls.push({ method: "register", environmentId, input });
      return Promise.resolve(answers.get(environmentId) ?? true);
    },
    registerLiveActivity: (environmentId, input) => {
      calls.push({ method: "registerLiveActivity", environmentId, input });
      return Promise.resolve(true);
    },
    unregister: (environmentId, deviceId) => {
      calls.push({ method: "unregister", environmentId, input: deviceId });
      return Promise.resolve(true);
    },
  };
  return { transport, calls, answers };
};

const input = {
  deviceId: "device-1",
  label: "iPhone",
  platform: "ios" as const,
  bundleId: "com.example.z6",
  pushToken: "apns-token",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

/** Runs what the registration queued on the app runtime until nothing is left. */
const drain = Effect.fn("TestPushGateway.drain")(function* () {
  for (let idle = 0; idle < 5;) {
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const next = mocks.pending.shift();
    if (!next) {
      idle++;
      continue;
    }
    idle = 0;
    const exit = yield* Effect.exit(next.operation as Effect.Effect<unknown, unknown>);
    next.resolve(exit);
  }
});

beforeEach(() => {
  vi.stubGlobal("__DEV__", false);
  mocks.configs.clear();
  mocks.subscribers.length = 0;
  mocks.pending.length = 0;
  mocks.startActivity.mockClear();
  mocks.os = "ios";
  vi.mocked(configureAndroidAgentNotifications).mockClear();
  __resetPushGatewayRegistrationsForTest();
  __resetAgentAwarenessRemoteRegistrationForTest();
  setPushGatewayTransport(null);
});

describe("push gateway registry", () => {
  it("registers with each server, repeating an unchanged registration at most once a minute", async () => {
    const { transport, calls, answers } = fakeTransport();
    answers.set(PLAIN, false);
    expect(await registerDeviceWithPushGateways(input, transport, [GATEWAY, PLAIN], 0)).toBe(
      "registered",
    );
    expect(await registerDeviceWithPushGateways(input, transport, [GATEWAY, PLAIN], 30_000)).toBe(
      "registered",
    );
    // The failed server is retried; the registered one is not until the minute passes.
    expect(calls.map((call) => call.environmentId)).toEqual([GATEWAY, PLAIN, PLAIN]);
    await registerDeviceWithPushGateways(
      { ...input, pushToken: "rotated" },
      transport,
      [GATEWAY],
      31_000,
    );
    expect(calls.at(-1)).toMatchObject({ environmentId: GATEWAY, input: { pushToken: "rotated" } });
    expect(await registerDeviceWithPushGateways(input, transport, [], 0)).toBe("none");
  });

  it("sends a card's token only to servers it registered with, and unregisters", async () => {
    const { transport, calls, answers } = fakeTransport();
    answers.set(PLAIN, false);
    await registerDeviceWithPushGateways(input, transport, [GATEWAY, PLAIN], 0);
    calls.length = 0;
    await registerLiveActivityWithPushGateways(
      { deviceId: "device-1", activityPushToken: "la" },
      transport,
      [GATEWAY, PLAIN],
    );
    expect(calls).toEqual([
      {
        method: "registerLiveActivity",
        environmentId: GATEWAY,
        input: { deviceId: "device-1", activityPushToken: "la" },
      },
    ]);
    await unregisterFromPushGateway(GATEWAY, transport);
    await unregisterFromPushGateway(PLAIN, transport);
    expect(calls.at(-1)).toEqual({
      method: "unregister",
      environmentId: GATEWAY,
      input: "device-1",
    });
    expect(calls.filter((call) => call.method === "unregister")).toHaveLength(1);
  });

  it("needs the app's bundle id, and keeps the APS environment to iOS", () => {
    const body = {
      ...input,
      iosMajorVersion: 18,
      apsEnvironment: "sandbox" as const,
      appVersion: "1.0.0",
    };
    expect(pushGatewayRegistrationInput(body)).toEqual({
      deviceId: "device-1",
      label: "iPhone",
      platform: "ios",
      bundleId: "com.example.z6",
      apsEnvironment: "sandbox",
      appVersion: "1.0.0",
      pushToken: "apns-token",
      preferences: input.preferences,
    });
    expect(pushGatewayRegistrationInput({ ...body, bundleId: undefined })).toBeNull();
  });
});

describe("registration in gateway mode", () => {
  it.effect("registers with servers that advertise a gateway once one appears", () =>
    Effect.gen(function* () {
      const { transport, calls } = fakeTransport();
      mocks.configs.set(PLAIN, { environment: { capabilities: {} } });
      startAgentAwarenessPushGateway(transport);
      yield* drain();
      expect(calls).toEqual([]);
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");

      mocks.configs.set(GATEWAY, { environment: { capabilities: { pushGateway: true } } });
      for (const listener of mocks.subscribers) listener(mocks.configs);
      yield* drain();
      expect(calls).toEqual([
        {
          method: "register",
          environmentId: GATEWAY,
          input: expect.objectContaining({
            deviceId: "device-1",
            platform: "ios",
            bundleId: "com.example.z6",
            apsEnvironment: "production",
            pushToken: "apns-token",
          }),
        },
      ]);
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }),
  );

  it.effect("gives Android's native handler the identity the server's messages carry", () =>
    Effect.gen(function* () {
      mocks.os = "android";
      const { transport, calls } = fakeTransport();
      mocks.configs.set(GATEWAY, { environment: { capabilities: { pushGateway: true } } });
      startAgentAwarenessPushGateway(transport);
      yield* drain();
      expect(configureAndroidAgentNotifications).toHaveBeenCalledWith(
        "device-1",
        PUSH_GATEWAY_ANDROID_USER_ID,
        true,
      );
      expect(calls[0]?.input).toMatchObject({
        platform: "android",
        bundleId: "com.example.z6.android",
        pushToken: "fcm-token",
      });
      expect(calls[0]?.input).not.toHaveProperty("apsEnvironment");
    }),
  );

  it("ignores the relay's sign-out reset, which runs at every launch", () => {
    setAgentAwarenessRelayTokenProvider(null);
    expect(configureAndroidAgentNotifications).not.toHaveBeenCalled();
  });

  it.effect("arms a Live Activity only for a server with a gateway", () =>
    Effect.gen(function* () {
      vi.mocked(loadPreferences).mockResolvedValue({ liveActivitiesEnabled: true } as Preferences);
      mocks.configs.set(PLAIN, {
        environment: { capabilities: { agentActivityPublishing: true } },
      });
      mocks.configs.set(GATEWAY, { environment: { capabilities: { pushGateway: true } } });
      const work = { threadTitle: "Fix the build", projectTitle: "z6" };
      armAgentAwarenessLiveActivityForLocalWork({ environmentId: PLAIN, ...work });
      yield* drain();
      expect(mocks.startActivity).not.toHaveBeenCalled();
      armAgentAwarenessLiveActivityForLocalWork({ environmentId: GATEWAY, ...work });
      yield* drain();
      expect(mocks.startActivity).toHaveBeenCalledTimes(1);
    }),
  );
});
