# Direct HTTP IPv6 Deployment Design

## Goal

Serve the poker scorekeeper directly over plain HTTP at `http://pk.tianyi.wiki` without a reverse proxy, TLS, or an ACME sidecar. The application container owns the public IPv6 address and accepts traffic on the default HTTP port 80.

## Scope

- Change the production application default from port 3000 to port 80.
- Bind the Node HTTP server to the IPv6 unspecified address `::` with dual-stack behavior so the same process accepts IPv6 and IPv4 where the host kernel permits it.
- Publish container TCP port 80 in the production Compose templates and expose port 80 in the image.
- Keep local/browser test harnesses on explicit port 3000 so tests do not require privileged host ports.
- Make the in-container health check use `PORT`, defaulting to 80, rather than a hard-coded port.
- Derive the browser session cookie's `Secure` attribute from `PUBLIC_ORIGIN` so production login works on the explicitly selected HTTP origin while HTTPS deployments remain protected.
- Disable Express proxy trust for this direct-access topology so clients cannot spoof their address with forwarded headers, and emit HSTS only when the configured public origin is HTTPS.
- Update the Extreme Space deployment guide for direct HTTP and a routable container IPv6 address.

## Explicit Non-Goals

- No application TLS listener and no port 443.
- No ACME container, certificate files, or Alibaba Cloud AccessKey in the application deployment.
- No reverse proxy.
- No automatic AliDNS AAAA updater in this change.

## Runtime Design

`apps/api/src/main.ts` exposes a small pure `getListenOptions()` helper returning `{ port, host: '::' }`. `bootstrap()` passes that address to Nest; Node's default for an IPv6 unspecified listener is dual-stack (`ipv6Only` is false unless explicitly enabled). `PORT` remains configurable for tests and development, but the fallback is 80.

The runtime image continues to run as UID/GID 1000. Production Compose explicitly sets the namespaced `net.ipv4.ip_unprivileged_port_start=0` sysctl so the non-root Node process can bind port 80 without adding capabilities or removing `no-new-privileges`.

For `PUBLIC_ORIGIN=http://pk.tianyi.wiki`, session cookies remain `HttpOnly` and `SameSite=Lax` but cannot carry `Secure`, because browsers do not return Secure cookies over HTTP. HTTPS origins keep `Secure`; a missing or malformed production origin fails closed with `Secure=true`.

Because the application is reached directly, Express always leaves `trust proxy` disabled and ignores client-supplied forwarded-address headers. Helmet disables HSTS for an HTTP public origin; production HTTPS deployments retain the existing one-year HSTS policy.

## Deployment and DNS

The production image exposes TCP 80 and the production Compose templates publish `80:80`. Extreme Space must attach the container to the existing network that gives it a globally routable IPv6 address. The firewall must allow inbound IPv6 TCP 80.

`pk.tianyi.wiki` must have an AAAA record equal to the application's current global IPv6 address. DNS correctness is verified separately from application listening; changing the application port cannot update a stale AAAA record.

## Security

HTTP traffic is unencrypted. Login credentials and session data can be observed or modified by any party able to intercept the connection. This is an explicit user-selected tradeoff for the current deployment. Existing application authentication, CSRF, origin checks, read-only root filesystem, non-root user, dropped capabilities, and secret scanning remain in place.

## Verification

- Unit test the default port and exact dual-stack listen options.
- Unit test the health-check URL derivation for default and overridden ports.
- Static deployment tests verify image/Compose port 80, non-root privileged-port sysctl, no port 3000 in production artifacts, and no ACME/TLS service.
- Build, typecheck, lint, focused unit tests, Compose rendering, and secret scan must pass before completion.
- Production acceptance must verify the container's actual IPv6, AAAA equality, TCP 80, HTTP live/ready endpoints, login, and WebSocket updates.
