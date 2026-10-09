import {
  type EnvironmentId,
  type SecureChannelSettings,
  type ServerConfig,
} from "@t3tools/contracts";
import { channelKeyFingerprint, decodeChannelKey } from "@t3tools/shared/secureChannel/handshake";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { parseSecureChannelOrigin } from "./pairingUrls";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * The end-to-end encrypted tunnel: a gateway on a loopback port that a Cloudflare Tunnel points at.
 * Pairing links for it carry the server key, so Cloudflare sees only ciphertext.
 */
export function SecureChannelRow({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Update the encrypted tunnel");
  const [isUpdating, setIsUpdating] = useState(false);
  const [originError, setOriginError] = useState<string | null>(null);
  const current = serverConfig?.settings.secureChannel;
  const serverKey =
    serverConfig?.secureChannelServerKey === undefined
      ? undefined
      : decodeChannelKey(serverConfig.secureChannelServerKey);

  const save = async (change: Partial<SecureChannelSettings>) => {
    setIsUpdating(true);
    try {
      await update({ environmentId, input: { patch: { secureChannel: change } } });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("encrypted-tunnel")}
      description={
        current?.enabled && current.publicOrigin !== ""
          ? `Point cloudflared at http://127.0.0.1:${current.port}. Pairing links for the public URL are end-to-end encrypted.`
          : current?.enabled
            ? "The gateway is off until the tunnel's public URL is set; every connection is bound to it."
            : "Run a gateway for a Cloudflare Tunnel that carries only ciphertext. Enter the tunnel's public URL, then turn it on. Works with the desktop and mobile apps."
      }
      status={
        originError ? (
          <span className="block text-destructive">{originError}</span>
        ) : current?.enabled && serverKey !== undefined ? (
          <span className="block font-mono">Server key {channelKeyFingerprint(serverKey)}</span>
        ) : null
      }
      control={
        current ? (
          <Switch
            checked={current.enabled}
            disabled={isUpdating || (!current.enabled && current.publicOrigin === "")}
            onCheckedChange={(enabled) => void save({ enabled })}
            aria-label="Enable the end-to-end encrypted tunnel"
          />
        ) : null
      }
    >
      {current ? (
        <div className="flex flex-wrap gap-2 pb-3">
          <Input
            key={`port:${current.port}`}
            className="w-24"
            aria-label="Gateway port"
            inputMode="numeric"
            defaultValue={String(current.port)}
            disabled={isUpdating}
            onBlur={(event) => {
              const port = Number(event.target.value.trim());
              if (!Number.isInteger(port) || port < 1 || port > 65_535) {
                event.target.value = String(current.port);
                return;
              }
              if (port !== current.port) void save({ port });
            }}
          />
          <Input
            key={`origin:${current.publicOrigin}`}
            className="min-w-0 flex-1"
            aria-label="Public URL"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="https://quiet.example.com"
            defaultValue={current.publicOrigin}
            disabled={isUpdating}
            onBlur={(event) => {
              const text = event.target.value.trim();
              const publicOrigin = text === "" ? "" : parseSecureChannelOrigin(text);
              if (publicOrigin === null) {
                setOriginError("Enter the tunnel's public URL, such as https://quiet.example.com.");
                return;
              }
              setOriginError(null);
              if (publicOrigin !== current.publicOrigin) void save({ publicOrigin });
            }}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}
