#!/usr/bin/env bash
#
# firewall.sh — apply the Hetzner Cloud Firewall for the
# `gtfs-rt.n3ary.com` Hetzner VM, fetching Cloudflare's current
# edge IP ranges from the CF API at run time.
#
# Why a script, not a static config: Cloudflare publishes the
# edge IP ranges at https://api.cloudflare.com/client/v4/ips and
# they DO change. Committing a static list (as `firewall.json`
# used to) goes stale silently. This script re-fetches on every
# run, so re-running it refreshes the rules.
#
# Re-run on:
#   - first deploy (initial setup)
#   - after a CF edge-IP change (CF posts to their changelog;
#     re-run is idempotent)
#   - when you want to rotate the SSH source IP (see SSH_IP below)
#
# Pre-reqs:
#   - hcloud CLI installed and authenticated (`hcloud context`)
#   - jq (for the JSON parse)
#
# Usage:
#   bash ops/hetzner/firewall.sh                                  # uses SSH_IP from the env or its built-in default
#   SSH_IP=1.2.3.4 bash ops/hetzner/firewall.sh                  # rotate the SSH source IP at the same time
#   HCLOUD_SERVER_NAME=other-server bash ops/hetzner/firewall.sh # target a different Hetzner server
#   HCLOUD_SERVER_ID=147556356 bash ops/hetzner/firewall.sh      # or by id
#
# SSH IP rotation (when your ISP gives you a new IP):
#
#   1. Detect the new IP from the workstation you'll SSH FROM:
#        curl -sSf https://api.ipify.org
#   2. Re-run with that IP, which replaces the SSH rule in place:
#        SSH_IP=$(curl -sSf https://api.ipify.org) bash ops/hetzner/firewall.sh
#   3. Verify:
#        hcloud firewall describe neary-gtfs-rt-01-edge-only
#      The first rule's source_ips should now be ["NEW_IP/32"].
#
# This works because the script idempotently calls
# `hcloud firewall replace-rules` on every run, so a one-liner is
# all the rotation procedure is. If you SSH from a second location
# (a second home, a VPN exit), pass SSH_IP_2 as well and the rule's
# source_ips becomes ["IP1/32", "IP2/32"].

set -euo pipefail

: "${HCLOUD_SERVER_NAME:=ubuntu-4gb-nbg1-1}"
: "${HCLOUD_SERVER_ID:=}"
: "${SSH_IP:=78.97.175.93}"        # default: Marius's current home IPv4 (set via env to rotate)
: "${SSH_IP_2:=}"                  # optional: second source for SSH (e.g. a second home, VPN exit)

command -v hcloud >/dev/null || { echo "hcloud CLI not installed" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not installed (apt-get install jq)" >&2; exit 1; }

FW_NAME="neary-gtfs-rt-01-edge-only"

# Fetch the live CF IP ranges (IPv4 + IPv6) from the public CF API.
# jq path: result.ipv4_cidrs[], result.ipv6_cidrs[]
cf_ips_json=$(curl -sSf https://api.cloudflare.com/client/v4/ips)
cf_ips_json=$(printf '%s' "$cf_ips_json" | jq -e '.success' >/dev/null && echo "$cf_ips_json" || {
  echo "CF /ips API returned non-success" >&2
  echo "$cf_ips_json" | head -5 >&2
  exit 1
})
cf_ips=$(printf '%s' "$cf_ips_json" | jq -r '.result.ipv4_cidrs[], .result.ipv6_cidrs[]' | jq -R . | jq -s .)

cf_ip_count=$(printf '%s' "$cf_ips" | jq 'length')
echo "fetched $cf_ip_count CF edge IP ranges (IPv4 + IPv6) from api.cloudflare.com/client/v4/ips"

# Resolve the server id if not given
if [ -z "$HCLOUD_SERVER_ID" ]; then
  HCLOUD_SERVER_ID=$(hcloud server list -o noheader -o columns=id,name | awk -v n="$HCLOUD_SERVER_NAME" '$2==n {print $1; exit}')
  [ -n "$HCLOUD_SERVER_ID" ] || { echo "server '$HCLOUD_SERVER_NAME' not found" >&2; exit 1; }
fi
echo "target server: $HCLOUD_SERVER_NAME (id $HCLOUD_SERVER_ID)"

# Build the rules JSON for hcloud firewall create/update.
# 8 rules:
#  - in tcp/22 from SSH_IP (your current home IPv4; pass SSH_IP= to rotate)
#  - in icmp from anywhere (ping)
#  - in tcp/80 from CF edge (orange-cloud HTTP)
#  - in tcp/443 from CF edge (orange-cloud HTTPS)
#  - out tcp/443 (ghcr.io pull, apt)
#  - out tcp/80 (apt redirects)
#  - out udp/53 (DNS)
#  - out icmp

# Compose the SSH source_ips array. Always includes $SSH_IP/32; if
# SSH_IP_2 is set, also includes that. Both are explicit /32 hosts,
# not subnets — only your two SSH source IPs can reach port 22.
ssh_sources=$(jq -nc --arg ip "$SSH_IP" --arg ip2 "$SSH_IP_2" \
  '$ip2 != "" | if . then [$ip, $ip2] else [$ip] end | map(. + "/32")')
ssh_count=$(printf '%s' "$ssh_sources" | jq 'length')
echo "SSH source IPs (port 22): $(printf '%s' "$ssh_sources" | jq -c .)"

read -r -d '' RULES_JSON <<EOF
{
  "rules": [
    {
      "direction": "in", "protocol": "tcp", "port": "22",
      "source_ips": $(printf '%s' "$ssh_sources" | jq -c .),
      "description": "SSH from operator's home IP (rotate via SSH_IP=...)"
    },
    {
      "direction": "in", "protocol": "icmp",
      "source_ips": ["0.0.0.0/0", "::/0"],
      "description": "ICMP from anywhere"
    },
    {
      "direction": "in", "protocol": "tcp", "port": "80",
      "source_ips": $(printf '%s' "$cf_ips" | jq -c .),
      "description": "HTTP from CF edge (orange-cloud proxy)"
    },
    {
      "direction": "in", "protocol": "tcp", "port": "443",
      "source_ips": $(printf '%s' "$cf_ips" | jq -c .),
      "description": "HTTPS from CF edge (orange-cloud proxy)"
    },
    {
      "direction": "out", "protocol": "tcp", "port": "443",
      "destination_ips": ["0.0.0.0/0", "::/0"],
      "description": "outbound HTTPS (ghcr.io, apt)"
    },
    {
      "direction": "out", "protocol": "tcp", "port": "80",
      "destination_ips": ["0.0.0.0/0", "::/0"],
      "description": "outbound HTTP (apt redirects)"
    },
    {
      "direction": "out", "protocol": "udp", "port": "53",
      "destination_ips": ["0.0.0.0/0", "::/0"],
      "description": "outbound DNS"
    },
    {
      "direction": "out", "protocol": "icmp",
      "destination_ips": ["0.0.0.0/0", "::/0"],
      "description": "outbound ICMP"
    }
  ],
  "resources": [{"type": "server", "id": $HCLOUD_SERVER_ID}]
}
EOF

# Create or replace the firewall. hcloud CLI's `firewall create`
# with --rules-file does the whole thing in one call.
fw_id=$(hcloud firewall list -o noheader -o columns=id,name | awk -v n="$FW_NAME" '$2==n {print $1; exit}')

if [ -n "$fw_id" ]; then
  echo "firewall $FW_NAME exists (id $fw_id) - replacing rules and re-applying"
  printf '%s' "$RULES_JSON" | jq '.rules' | hcloud firewall replace-rules --rules-file /dev/stdin "$FW_NAME" >/dev/null
  hcloud firewall apply-to-resource --type server --server "$HCLOUD_SERVER_NAME" "$FW_NAME" >/dev/null
else
  echo "firewall $FW_NAME does not exist - creating + applying"
  printf '%s' "$RULES_JSON" | hcloud firewall create --name "$FW_NAME" --label "io.github.n3ary.component=gtfs-rt" --rules-file /dev/stdin >/dev/null
  hcloud firewall apply-to-resource --type server --server "$HCLOUD_SERVER_NAME" "$FW_NAME" >/dev/null
fi

echo "ok: $FW_NAME applied to $HCLOUD_SERVER_NAME (SSH restricted to $ssh_count IP(s))"
echo "verify: hcloud firewall describe $FW_NAME"
