# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

A saved environment holds an ordered list of routes, and the
[driver](../../packages/client-runtime/src/connection/driver.ts) connects over
the first that works. Each direct route is first checked with the public
descriptor, so a saved LAN address that a different machine answers on another
network receives no credential. That check is not proof of a working route:
when every route stays silent, each is still tried. A route that fails to
connect, including a blocked one such as a signed-out T3 Connect, moves on to
the next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights the earlier ones and replaces the session when one would connect.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the credential of
the route it was learned over: the T3 Connect access token, which is not bound
to an origin because each DPoP proof names the URL it signs, or the paired
bearer token. Learned routes the server stops reporting are dropped, which is
how a changed LAN address replaces the old one; routes the user saved are never
touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

GitHub routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## End-to-end encrypted routes

An encrypted route reaches the server through the
[secure channel gateway](../../apps/server/src/secureChannel/SecureChannelGateway.ts),
which a Cloudflare Tunnel points at. The server key in the pairing link is the root of
trust and never travels through the tunnel. The gateway sends no byte to anything but a
valid handshake from a paired client key or one carrying a live pairing code, so the
hostname looks unused. An error page, a health route, or any other answer on that port
gives the service away.

Anyone holding the channel's path, such as a past holder of a pairing link, can send handshakes
that cost the server 0.6 to 2.5 ms each, on the same thread as everything else. Every address
is limited on its own. An address where a paired device completed a handshake in the last day
is known and skips the rest, so a flood from strangers usually doesn't shed the user's devices
on addresses they used lately. It still can when the flood comes from that exact address, such
as behind the same carrier NAT, when the only device known there is gone, or when 63 or more
keys have pushed the address out. A pairing code doesn't make an address known, since a
handshake doesn't use the code up.

Each key keeps at most 16 known addresses, shared with any other key that used them, and loses
each a day after it last connected there, so even a stolen key holds little standing. Known
addresses share no cap on attempts, so one key's can still spend about 0.5 to 2% of a core. A
key loses its addresses at once when revoked in Settings. Revoked from the CLI, which runs in
another process, it loses them at its next handshake that reaches the server, or within the
hour if it holds a channel, and otherwise within a day, at a restart, or when the tunnel is
switched off and on.

Strangers, new pairings among them, are also limited per network block (IPv6 /48, IPv4 /24)
and together under a cap of about a sixth of a core; during a flood, a new pairing or a device
on an unfamiliar address is turned away until it passes. The known set lives in memory. A
global limit on everyone would let a flood lock out every device, and no limit on strangers
would leave the server's thread to whoever floods it. `t3 channel rotate` moves the path,
which cuts off whoever held it.

A saved encrypted environment pins its server key across every address: pairing refuses any
link for it that doesn't carry that key, whichever flow opens the link, so no plain route is
ever added to an encrypted environment. That shuts out a link that echoes the environment's id,
which isn't secret, from a LAN address that would be tried first.

The server knows a request came through the channel only because the gateway registers
each upstream connection's local port, and the client key behind it, before writing to it.
Every session paired through the channel, whether by token exchange, browser cookie or MCP
approval, carries that key (`cck`), and
[environment auth](../../apps/server/src/auth/EnvironmentAuth.ts) accepts its tokens only
on a connection from the same client's channel. A credential check that bypasses that rule
lets a token taken from the device work from anywhere else that can reach the server. The
desktop keeps each route's channel key in its main process, so a compromised renderer can't
take one.

Clients use an encrypted route only through a loopback forwarder per route, in the desktop
main process or the mobile native module, and use its local origin in place of the
route's. The route's own host gets no plain request: the runtime's fetch and WebSocket
refuse it, the driver skips its descriptor check, and the supervisor learns no routes over
it. The one exception is a GET at the channel's path when a channel behind Cloudflare Access
won't open, to tell Access refusing the token from a gateway that's down; the gateway never
answers it. A network path that skips the runtime's guarded fetch or WebSocket breaks this.
Other processes on the device, and on iOS other apps, can reach a forwarder's port, and so
the server's unauthenticated routes as this device; anything else still needs a session.

The channel is our own `Noise_IK_25519_ChaChaPoly_SHA256` on the `@noble` primitives, checked
against the cacophony vector: React Native has no TLS over an arbitrary stream, and Noise
libraries assume libp2p or `sodium-native`. It carries plain byte streams rather than HTTP so
that every loader, from images and video to WebViews and uploads, works unchanged through the
forwarder. Nothing is compressed inside it, because compressing before encrypting shows the
carrier how well each message compressed; the server compresses what it serves, and a client
that negotiates WebSocket compression on the RPC socket gets that inside the channel, as on
any other route.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, relay, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
