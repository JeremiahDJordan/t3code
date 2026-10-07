// @vitest-environment jsdom
import {
  cloudflareAccessHeaders,
  setConnectionTransportHeaders,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const seen = vi.hoisted(() => {
  const state = {
    url: "",
    fetches: [] as Array<{ url: string; headers: Record<string, string> | undefined }>,
  };
  return {
    state,
    /** One stable function, as `useRefreshAssetUrl` returns, so the hook's effects settle. */
    refresh: async () => state.url,
  };
});

vi.mock("expo/fetch", () => ({
  fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.state.fetches.push({ url, headers: init?.headers });
    return new Response("hello", { status: 200 });
  },
}));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("./attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => seen.refresh }));

import { useAttachmentDocument } from "./attachmentDocument";

const ACCESS_ROUTE = "https://t3.access.example/";
const ACCESS = cloudflareAccessHeaders({ clientId: "id.access", clientSecret: "secret" });

let root: Root | null = null;
let latest: ReturnType<typeof useAttachmentDocument> | undefined;

function Probe() {
  latest = useAttachmentDocument({
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    attachmentId: "att_1",
    environmentId: EnvironmentId.make("env-1"),
    attachment: null,
  });
  return null;
}

async function readSource(url: string) {
  seen.state.url = url;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
  // The signed URL resolves, then the text read runs: two settled turns.
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return seen.state.fetches;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = undefined;
  seen.state.fetches = [];
  setConnectionTransportHeaders(ACCESS_ROUTE, undefined);
});

describe("reading an attachment's text on a Cloudflare Access route", () => {
  it("fetches the signed URL with the route's service token and the read's own headers", async () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    const signed = "https://t3.access.example/api/assets/signed-token/notes.txt";
    const fetches = await readSource(signed);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe(signed);
    expect(fetches[0]!.headers).toEqual({ ...ACCESS, Range: expect.stringMatching(/^bytes=0-/) });
    expect(latest?.content).toEqual({ text: "hello", truncated: false });
  });

  it("sends nothing to a route learned on another address", async () => {
    setConnectionTransportHeaders(ACCESS_ROUTE, ACCESS);
    const other = "https://desk.tailnet.ts.net/api/assets/signed-token/notes.txt";
    const fetches = await readSource(other);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.headers).toEqual({ Range: expect.stringMatching(/^bytes=0-/) });
  });
});
