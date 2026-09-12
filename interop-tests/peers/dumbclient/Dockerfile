# smpp-dumb-client has no published image; built from source at a pinned commit. A second binary
# is built from the same source with its own automatic enquire_link neutralised, for S6 - see
# findings/07-load.md for why (every peer built for this phase sends enquire_link on its own
# otherwise, and smppload, the one that never does, is blocked).
FROM --platform=linux/amd64 golang:1.26.8-alpine3.23 AS builder

RUN apk add --no-cache git ca-certificates

ARG LIBSMPP_COMMIT=de0334bf2c1155fb3dd4f929674968254c932be6

RUN git clone https://github.com/vponomarev/libsmpp.git /build \
	&& cd /build \
	&& git checkout "${LIBSMPP_COMMIT}"

WORKDIR /build
RUN go build -o /out/smpp-dumb-client ./app/smpp-dumb-client

# libsmpp's enquireSender(60)/enquireSender(10) are the two call sites that start its unconditional,
# unconfigurable 10s/60s enquire_link ticker (smpp.go) - both neutralised here for the no-ping build.
RUN sed -i \
		-e 's/go s\.enquireSender(60)/\/\/ patched for S6 (no enquire_link): &/' \
		-e 's/go s\.enquireSender(10)/\/\/ patched for S6 (no enquire_link): &/' \
		smpp.go \
	&& go build -o /out/smpp-dumb-client-noping ./app/smpp-dumb-client

FROM --platform=linux/amd64 alpine:3.23.5 AS runtime

RUN apk add --no-cache netcat-openbsd

WORKDIR /app
COPY --from=builder /out/smpp-dumb-client /app/smpp-dumb-client
COPY --from=builder /out/smpp-dumb-client-noping /app/smpp-dumb-client-noping
COPY entrypoint.sh /app/entrypoint.sh
COPY conf ./conf
RUN chmod +x /app/entrypoint.sh /app/smpp-dumb-client /app/smpp-dumb-client-noping

ENTRYPOINT ["/app/entrypoint.sh"]
