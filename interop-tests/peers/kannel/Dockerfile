FROM debian:bookworm-20260824-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends kannel=1.4.5-12 \
	&& rm -rf /var/lib/apt/lists/*

COPY main.conf iv33.conf maxpending1.conf notransceiver.conf /etc/kannel/
