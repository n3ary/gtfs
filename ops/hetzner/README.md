# `ops/hetzner/` — runtime configs for the GTFS-RT Hetzner VM

Everything in this directory is **deploy-side** — files that get
copied onto the host (or a fresh VM) to run the `gtfs-rt`
container. The repo-stay is purely so the configs are versioned
alongside the artifact they're for; the contents are still
target-specific (currently Hetzner CX23 with systemd + podman).

| File | Purpose | Installed at |
|---|---|---|
| `firewall.sh` | Hetzner Cloud Firewall bootstrap. Fetches the current CF edge IP ranges (IPv4 + IPv6) from `https://api.cloudflare.com/client/v4/ips` at run time and applies the rules via `hcloud firewall create` / `replace-rules`. Re-run when CF adds an edge range (CF posts to their changelog). | Hetzner Cloud (network-layer; not on the VM) |
| `dnat-80-to-8080.sh` | iptables DNAT: forwards port 80 → 8080 on the host, so the CF edge can connect to port 80 (its default) while the Fastify origin binds 8080. Idempotent. | `/usr/local/sbin/dnat-80-to-8080.sh` |
| `dnat-80-to-8080.service` | systemd one-shot unit that runs the DNAT script at boot. Persistence so the rule survives reboots. | `/etc/systemd/system/dnat-80-to-8080.service` |

The single bootstrap script (`install.sh`) lives in
[`apps/gtfs-rt/config/install.sh`](../gtfs-rt/config/install.sh) — that's the one the operator runs on the host. It transitively copies `dnat-80-to-8080.sh` and `dnat-80-to-8080.service` from this directory and enables the DNAT systemd unit.

That's the entry point for "rebuild a Hetzner server from
scratch" — `install.sh` is idempotent and meant to be the single
command you run on a fresh VM. The DNAT is a separate unit so it
can be turned on/off without touching the service.

## First-boot order

1. `apt-get update && apt-get -y install git`
2. `git clone https://github.com/n3ary/gtfs-publisher.git && cd gtfs-publisher`
3. (Optional) `export IMAGE=ghcr.io/n3ary/gtfs-rt:sha-<hex>` to pin
4. `bash apps/gtfs-rt/config/install.sh` — installs podman, copies unit + env, copies the DNAT script + unit, enables both, pulls image, starts the service
5. `curl -sSf http://127.0.0.1:8080/healthz` — should return 200 JSON
   (`curl -sSI http://127.0.0.1/healthz` should also work — that's the DNAT'd path)

## Smoke test from the public internet

```bash
curl -sI https://gtfs-rt.n3ary.com/rt/cluj-napoca/vehicle_positions
# expect: HTTP/2 200, content-type: application/x-protobuf,
# cache-control: public, max-age=5, cf-cache-status: MISS (first call) → HIT (within 5s)
```

## Hetzner Cloud Firewall

Built and applied by `ops/hetzner/firewall.sh`. The script fetches
the current Cloudflare edge IP ranges (IPv4 + IPv6) from
`https://api.cloudflare.com/client/v4/ips` at run time and applies
the resulting rules via `hcloud firewall create` / `replace-rules`.
A static rules file would go stale silently when CF adds a new
edge range — the script re-fetches on every invocation, so
re-running it is enough to refresh.

Inbound:
- tcp/22 from `$SSH_IP/32` (the operator's current home IPv4 — see
  rotation procedure below). A second source can be added with
  `SSH_IP_2=...` (e.g. a second home, a VPN exit).
- tcp/80 + tcp/443 from the live CF edge IP ranges (the
  orange-cloud proxy). Other source IPs are blocked at the network
  layer.
- icmp from anywhere (ping).

Outbound: 80/443/53/icmp to anywhere (ghcr.io pull, apt, DNS).
Everything else is blocked.

The firewall sits at the Hetzner edge — it's a *network-layer*
control, in addition to whatever you put on the VM with iptables.
The CF edge always reaches the VM via 178.104.6.65:80 (or :443 if
you set SSL=full_strict on the zone instead of `full`).

### Usage

```bash
# pre-reqs: hcloud CLI authenticated, jq installed
bash ops/hetzner/firewall.sh                                    # uses default server + SSH_IP=78.97.175.93
HCLOUD_SERVER_ID=147556356 bash ops/hetzner/firewall.sh         # or by id
hcloud firewall describe neary-gtfs-rt-01-edge-only             # verify
```

### Rotating the SSH source IP (when your ISP gives you a new IP)

The script idempotently calls `hcloud firewall replace-rules` on
every run, so rotation is a one-liner from the workstation you'll
SSH FROM:

```bash
# 1. find your current public IP
curl -sSf https://api.ipify.org
# -> e.g. 78.97.175.93

# 2. re-run firewall.sh with the new IP as SSH_IP
SSH_IP=$(curl -sSf https://api.ipify.org) bash ops/hetzner/firewall.sh

# 3. verify the rule was replaced in place
hcloud firewall describe neary-gtfs-rt-01-edge-only | grep -A3 'port: "22"'
```

The script's built-in default for `SSH_IP` is the operator's home
IPv4 at the time of writing. Pass `SSH_IP=...` to override
without editing the file. If you SSH from a second location, pass
`SSH_IP_2=...` and the rule's source_ips becomes `[IP1/32, IP2/32]`.

Why a one-shot env var instead of editing the script: editing the
script on every rotation churns the repo history with one-line IP
bumps and creates a public-PR trail of your home address. The env
var keeps the repo at "current IP" without exposing your rotations
in git log.
