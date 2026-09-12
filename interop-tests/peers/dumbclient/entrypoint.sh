#!/bin/sh
# smpp-dumb-client is one-shot and dials out, so it needs node:2775 already listening - the same
# problem compose.smppload.yaml's entrypoint solves, and the same fix: a healthcheck this marker
# satisfies at once, and node depends on it rather than the other way round.
#
# Its own smpp.remote config field is fed straight into net.ParseIP with no DNS resolution at all
# (hdr.go), so the compose service name in every conf/*.yml is a NODE_HOST placeholder, resolved
# here and substituted into a writable copy before the real binary ever sees the config file.
set -eu

touch /tmp/healthy

host="${SMPP_HOST:-node}"
port="${SMPP_PORT:-2775}"

until nc -z "$host" "$port"; do
	sleep 1
done

ip="$(getent hosts "$host" | awk '{print $1}' | head -n1)"
sed "s/NODE_HOST/$ip/" "$1" > /tmp/effective-config.yml

exec "${DUMBCLIENT_BIN:-/app/smpp-dumb-client}" -config /tmp/effective-config.yml
