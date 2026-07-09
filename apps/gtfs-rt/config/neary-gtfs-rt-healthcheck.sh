#!/usr/bin/env bash
# neary-gtfs-rt-healthcheck.sh -- hourly container health probe.
#
# Runs from a systemd timer (neary-gtfs-rt-healthcheck.timer).
# Probes the local container and restarts the systemd unit on
# failure. No external dependencies: no CF, no GH, no network
# beyond 127.0.0.1.
#
# Exit codes:
#   0 - healthy (or recovered via restart)
#   1 - unhealthy, restart did not bring it back
#   2 - probe error (e.g. curl timeout) AND restart not attempted

set -uo pipefail

UNIT=neary-gtfs-rt
LOG_TAG=neary-gtfs-rt-healthcheck
PROBE_URL=http://127.0.0.1/healthz
PROBE_TIMEOUT=5
RESTART_WAIT_PROBES=10   # 10 probes * 3 s = 30 s for rollback
PROBE_INTERVAL=3

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | systemd-cat -t "$LOG_TAG" ; }

probe_health() {
  # Returns one of: healthy | healthz-ok | down | unhealthy
  local hc_status
  hc_status=$(podman inspect "$UNIT" --format '{{.State.Healthcheck.Status}}' 2>/dev/null || echo none)
  case "$hc_status" in
    healthy) echo healthy; return ;;
    unhealthy|starting|none|"")
      # HEALTHCHECK not defined OR container not yet up.
      # Fall back to a single curl probe of /healthz.
      if curl -fsS --max-time "$PROBE_TIMEOUT" "$PROBE_URL" >/dev/null 2>&1; then
        echo healthz-ok
      elif ! podman container exists "$UNIT" 2>/dev/null; then
        echo down
      else
        echo unhealthy
      fi
      ;;
    *) echo unknown;;
  esac
}

restart_unit() {
  log "restarting $UNIT"
  systemctl restart "$UNIT"
  for _ in $(seq 1 "$RESTART_WAIT_PROBES"); do
    sleep "$PROBE_INTERVAL"
    state=$(probe_health)
    case "$state" in
      healthy|healthz-ok)
        log "restart succeeded; state=${state}"
        return 0
        ;;
    esac
  done
  log "restart did not bring $UNIT back to healthy in $((RESTART_WAIT_PROBES * PROBE_INTERVAL))s"
  return 1
}

state=$(probe_health)
log "probe: state=${state}"

case "$state" in
  healthy|healthz-ok)
    log "ok; no action needed"
    exit 0
    ;;
  down|unhealthy|unknown)
    log "container is ${state}; attempting restart"
    if restart_unit; then
      exit 0
    fi
    log "FAIL: ${state} and restart did not recover; container is wedged - operator must intervene"
    exit 1
    ;;
esac

# Should not reach here, but be defensive.
log "FAIL: unhandled probe state '${state}'"
exit 2