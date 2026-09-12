# smppload has no published image; built from source at a pinned commit (tag 2.5.3). Its deps
# resolve some sub-deps over git:// (rebar.config), rewritten to https below - see findings/07-load.md.
FROM --platform=linux/amd64 erlang:27.3.4.17-alpine AS builder

RUN apk add --no-cache curl git make build-base ca-certificates \
	&& git config --global url."https://github.com/".insteadOf "git://github.com/"

ARG SMPPLOAD_COMMIT=49fb653966081052fa5d36fbadbdb0972f25ded5
ARG REBAR3_VERSION=3.27.0

# The commit's own vendored ./rebar3 escript predates OTP 27 and cannot even load under it
# ("please re-compile this module with an Erlang/OTP 27 compiler") - issue #8's BEAM load error.
# A current rebar3 release, which still reads this project's rebar.config, replaces it.
RUN curl -fsSL -o /usr/local/bin/rebar3 "https://github.com/erlang/rebar3/releases/download/${REBAR3_VERSION}/rebar3" \
	&& chmod +x /usr/local/bin/rebar3

RUN git clone https://github.com/PowerMeMobile/smppload.git /build \
	&& cd /build \
	&& git checkout "${SMPPLOAD_COMMIT}" \
	&& cp /usr/local/bin/rebar3 ./rebar3 \
	&& make escriptize

FROM --platform=linux/amd64 erlang:27.3.4.17-alpine AS runtime

RUN apk add --no-cache netcat-openbsd

WORKDIR /app
COPY --from=builder /build/_build/default/bin/smppload /app/smppload
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/smppload

ENTRYPOINT ["/app/entrypoint.sh"]
