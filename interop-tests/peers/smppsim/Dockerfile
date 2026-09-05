# SMPPSim's own site (seleniumsoftware.com) answers 522; kwahome/smpp-sim-docker vendors the last
# surviving 2.6.11 build (see ../../research/smsc-simulators.md #1). Cloned at a pinned commit here
# rather than vendored into this repo.
FROM debian:13.2-slim AS source

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*

ARG SMPPSIM_COMMIT=bc299828af9046ab290da3b4957dfbc472f02bfb

RUN git clone https://github.com/kwahome/smpp-sim-docker.git /src \
	&& cd /src && git checkout "${SMPPSIM_COMMIT}"

# SMPPSim 2.6.x targets Java 6/7; runs unmodified on this 8 JRE.
FROM eclipse-temurin:8u452-b09-jre

WORKDIR /app

COPY --from=source /src/SMPPSim/smppsim.jar ./smppsim.jar
COPY --from=source /src/SMPPSim/lib ./lib
COPY --from=source /src/SMPPSim/www ./www
COPY --from=source /src/SMPPSim/mo ./mo
COPY --from=source /src/SMPPSim/conf/logging.properties ./conf/logging.properties
COPY *.props ./conf/

EXPOSE 2775 8884

ENTRYPOINT ["java", "-Djava.net.preferIPv4Stack=true", "-Djava.util.logging.config.file=conf/logging.properties", "-jar", "smppsim.jar"]
CMD ["conf/smppsim.props"]
