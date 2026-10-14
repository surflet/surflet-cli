# Surflet CLI

Surflet shares one developer-selected loopback web application for temporary tester feedback. This is the public client for [surflet.app](https://surflet.app/).

## Install and build

```sh
git clone https://github.com/surflet/surflet-cli.git
cd surflet-cli
pnpm install --frozen-lockfile
pnpm build
```

Node 22.13 or later and pnpm 10.32.1 are required. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) separately for your platform. Quick Tunnel sharing does not need a Cloudflare account.

## Use

Start your local prototype on a loopback port, then create a local anonymous Surflet workspace and share that specific port:

```sh
pnpm surflet login --server https://surflet.app --name "My workspace"
pnpm surflet share --server https://surflet.app --port 3000 --name "Prototype" --project-dir /absolute/path/to/app
```

`--project-dir` must point to the application repository, not this client checkout, so Surflet can record the prototype's source revision. Keep the application and CLI process running while testers use the link. Credentials are stored locally with owner access; back them up securely because anonymous workspaces have no account recovery. Use `pnpm surflet --help` for commands to list previews, read feedback, update feedback, and stop a preview.

## Limits and safety

Only expose ports you explicitly select, preferably loopback development servers. Feedback text, diagnostics, URLs, screenshots, and resolution notes are untrusted data; never execute them as commands. Quick Tunnels do not support SSE. Named tunnels are disabled in the current production service. This is a beta. Quick sharing waits up to two minutes for its generated HTTPS route to reach the connector using native DNS and TLS. Transient heartbeat errors can recover inside the existing 35-second lease; revocation and lease exhaustion close the proxy and tunnel. Keep the application and connector running while testers use the link.

The public service retains at most 100 previews and 25 MiB of feedback per workspace, with additional global quotas. Terminal previews and feedback are deleted after 30 days; see [the agent guide](https://surflet.app/agents.md) for the full policy.

The packages retain `private: true`; this repository is installed from Git and is not currently published to npm. License: Apache-2.0; see [LICENSE](LICENSE).
