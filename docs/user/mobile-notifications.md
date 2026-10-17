# Mobile notifications

Enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Notifications come from servers that can push: through your own push gateway (below), or, in builds with T3 Connect, through T3 Connect once you sign in and link your environments with agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. A direct or Tailscale connection alone does not deliver notifications while the app is closed; a push gateway or T3 Connect does. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Push through your own gateway

A push gateway is a small Cloudflare Worker you deploy on your own Cloudflare account with your Apple push key and Firebase service account; `infra/push-gateway/README.md` walks through it. Your server decides what to send and hands finished notifications to the gateway, which signs and forwards them to Apple or Google.

1. Deploy the gateway and mint a credential for each server.
2. On each server, set `T3CODE_PUSH_GATEWAY_URL` to the gateway's address and `T3CODE_PUSH_GATEWAY_CREDENTIAL` to that server's credential, then restart it.
3. Open the app. It registers with every connected server that has a gateway; **Settings → Notifications** lists them under **Servers that push**.

Removing a server from the app, or revoking the app's pairing on the server, stops that server's notifications. Revoking a server's credential at the gateway stops everything it sends.

The gateway sees what it forwards, including thread and project titles, and stores none of it. Live Activities and ongoing cards show one server's threads at a time: two servers working at once take turns updating the same card. iOS needs an app build signed with a paid Apple Developer team; Personal Team builds have no push.
