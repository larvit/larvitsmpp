# No licence declared for this fork (composer.json says LGPL-2.0-or-later, but no top-level
# LICENSE file - see findings/06-python-php.md); test-only, cloned at a pinned commit, never
# vendored into this repo.
FROM php:8.4.25-cli AS source

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ARG PHPSMPP_COMMIT=1d3b53c2d2b63d51ab70009d956914b7f8903118

RUN git clone https://github.com/alexandr-mironov/php-smpp.git /src \
	&& cd /src \
	&& git checkout "${PHPSMPP_COMMIT}"

# PHP 8's sockets extension returns a Socket object from socket_create(), not a resource; this
# fork's own isOpen() checks is_resource() alone (written pre-PHP8), so it is always false and every
# guarded call ("Socket is not open") fails immediately, on any PHP 8.x. Patched here, not in
# src/Socket.php - see findings/06-python-php.md.
RUN sed -i 's/if (!is_resource(\$this->socket)) {/if (!is_resource(\$this->socket) \&\& !(\$this->socket instanceof \\Socket)) {/' /src/src/transport/Socket.php

FROM php:8.4.25-cli

RUN apt-get update \
	&& apt-get install -y --no-install-recommends libonig-dev \
	&& rm -rf /var/lib/apt/lists/* \
	&& docker-php-ext-install sockets mbstring

WORKDIR /app
COPY --from=source /src/src /app/smpp-src
COPY driver.php .

EXPOSE 8080
ENTRYPOINT ["php", "/app/driver.php"]
CMD ["node", "2775"]
