#!/bin/sh
# smppload is one-shot: it needs node:2775 already accepting connections, but compose starts this
# container first (its healthcheck is a bare marker file, not the SMPP link) so node can depend on
# it the same way compose.kannel.yaml's bearerbox does. This loop is the retry Kannel's own client
# gives it for free.
set -eu

touch /tmp/healthy

host="${SMPP_HOST:-node}"
port="${SMPP_PORT:-2775}"

until nc -z "$host" "$port"; do
	sleep 1
done

exec /app/smppload "$@"
