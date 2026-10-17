# Z6 Code push gateway

A small Cloudflare Worker on your own account that lets your T3 servers send push
notifications and Live Activity updates to your phone without T3 Connect.

Each server decides what to send and when, from its own threads, and posts finished
APNs and FCM deliveries to the gateway. The gateway holds your Apple and Firebase keys,
checks the server's credential and the app's bundle id, signs the request and forwards
it. It stores no devices, threads or messages.

Privacy: the gateway sees what it forwards, which includes thread and project titles in
notification text and Live Activity content. It keeps none of it; Cloudflare's request
logs (`observability` in `wrangler.jsonc`) record requests, not bodies.

## What you need

- A Cloudflare account. The free plan is enough.
- iOS: a paid Apple Developer team, an app id with Push Notifications, and an iPhone
  build signed with that team. Personal Team builds have no push.
- Android: a Firebase project with your app's package name added.
- Node 24 to run the credential script, and `npx`, which downloads Wrangler when you
  deploy. Wrangler is not a dependency of this repository.

## Set up

1. **Apple key.** In Apple Developer, Certificates, Identifiers & Profiles → Keys, create
   a key with Apple Push Notifications service (APNs). Download the `.p8` file (Apple
   lets you download it once) and note its Key ID and your Team ID. One key serves
   sandbox and production, alerts and Live Activities.
2. **Firebase service account.** In the Firebase console, Project settings → Service
   accounts, generate a new private key and keep the JSON file. The Firebase Cloud
   Messaging API (V1) must be enabled. The Android build needs the project's
   `google-services.json` (`T3CODE_ANDROID_GOOGLE_SERVICES_FILE`).
3. **Configure.** In `wrangler.jsonc`, set:
   - `ALLOWED_BUNDLE_IDS`: every iOS bundle id and Android package your builds use,
     comma-separated, such as `com.example.z6,com.example.z6.dev`. The gateway refuses
     any other topic, so a credential can't use your keys for someone else's app.
   - `APNS_TEAM_ID` and `APNS_KEY_ID`.
   - The `ratelimits` block limits each server credential to 120 requests a minute.
     `namespace_id` is any number unique in your account; delete the block to turn the
     limit off.
4. **Secrets.** From this folder:

   ```sh
   npx wrangler login
   npx wrangler secret put APNS_PRIVATE_KEY < AuthKey_ABC123.p8
   npx wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
   ```

   Leave either out to serve only the other platform; its deliveries are refused, and
   the server drops them without retrying.

5. **Server credentials.** Mint one per server:

   ```sh
   node scripts/mint-credential.ts laptop
   ```

   It prints the secret once, for that server, and an entry such as
   `{"id":"laptop","sha256":"…"}`. Put every server's entry in one JSON array:

   ```sh
   npx wrangler secret put PUSH_GATEWAY_CREDENTIALS
   # paste: [{"id":"laptop","sha256":"…"},{"id":"desktop","sha256":"…"}]
   ```

   The gateway stores only the hashes. To revoke a server, put the array again without
   its entry. To rotate, mint a new credential and replace the entry.

6. **Deploy.**

   ```sh
   npx wrangler deploy
   curl https://z6-push-gateway.<your-subdomain>.workers.dev/health   # ok
   ```

7. **Point each server at it.** In the server's environment (not a committed file):

   ```sh
   T3CODE_PUSH_GATEWAY_URL=https://z6-push-gateway.<your-subdomain>.workers.dev
   T3CODE_PUSH_GATEWAY_CREDENTIAL=z6pg_…
   ```

   Restart the server. It now offers push to paired phones, and the phone registers
   with it the next time it connects or comes to the foreground. Without both
   variables a server sends nothing and contacts no gateway.

## The protocol

`POST /v1/deliveries` with `Authorization: Bearer <credential>` and
`{ "deliveries": [...] }`, at most 40 per request (each one is a subrequest, and the
free plan allows 50). A delivery is
`{ platform, token, kind, bundleId, apsEnvironment?, priority?, collapseId?, expiration?, payload }`:
`payload` is the APNs JSON body, or for Android the FCM message's `data` and `android`
options (the gateway adds the token and `restricted_package_name`). The answer is
`{ "results": [{ ok, status, reason? }] }` in request order; `status` is APNs' or FCM's,
403 `TopicNotAllowed` for a bundle id outside the list, 403 `ApnsNotConfigured` or
`FcmNotConfigured` for a platform without keys,
and 0 when APNs or FCM could not be reached. The schema is `PushGatewayRequest` in
`packages/contracts/src/pushGateway.ts`.

APNs provider tokens are signed deterministically and reused for 45 minutes, so every
Worker isolate presents the same token and APNs never sees too many token refreshes.
Google access tokens are cached per isolate for 50 minutes.

## Develop

```sh
vp test run --config ../../vite.config.ts --dir .
vpr typecheck
```
