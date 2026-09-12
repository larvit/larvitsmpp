# cloudhopper-smpp (the fizzed fork) has no published artifact; cloned at a fixed commit and
# installed into the local Maven repo, which the driver build below then depends on.
FROM maven:3.9.11-eclipse-temurin-21 AS cloudhopper-source

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

ARG CLOUDHOPPER_COMMIT=ae6485a86c968d344bebf0fa180928905b4a8ad1

# The parent pom (fizzed-maven-parent:1.15) hardcodes source/target 1.7 in its own compiler-plugin
# config, which -Dmaven.compiler.source cannot override; ch-smpp's own pom declares no <build> of
# its own, so injecting one here (source/target 8, otherwise unmodified) is the narrowest override.
RUN git clone https://github.com/fizzed/cloudhopper-smpp.git /src \
	&& cd /src \
	&& git checkout "${CLOUDHOPPER_COMMIT}" \
	&& sed -i 's#</project>#<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><configuration><source>8</source><target>8</target></configuration></plugin></plugins></build></project>#' pom.xml \
	&& mvn -q install -Dmaven.test.skip=true -Dgpg.skip=true -Dmaven.javadoc.skip=true

# A self-signed cert this image trusts, generated at build time - never committed. server.key/crt
# are PEM (for our server()'s own tls option); truststore.jks is what the driver's SSL client trusts.
FROM eclipse-temurin:21.0.8_9-jre-jammy AS certs

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /certs \
	&& openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
		-keyout /certs/server.key -out /certs/server.crt -subj "/CN=interop-cloudhopper" \
	&& keytool -importcert -noprompt -alias interop -file /certs/server.crt \
		-keystore /certs/truststore.jks -storepass changeit \
	&& openssl pkcs12 -export -in /certs/server.crt -inkey /certs/server.key \
		-out /certs/keystore.p12 -name interop -password pass:changeit

FROM maven:3.9.11-eclipse-temurin-21 AS build

COPY --from=cloudhopper-source /root/.m2 /root/.m2

WORKDIR /driver
COPY pom.xml .
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21.0.8_9-jre-jammy AS runtime

WORKDIR /app
COPY --from=build /driver/target/driver.jar ./driver.jar
COPY --from=certs /certs /certs

EXPOSE 8080
# node's test file needs the same server.key/server.crt to configure its own tls option; the
# S10 compose overlay mounts a shared volume at /shared-certs on both this service and node.
ENTRYPOINT ["sh", "-c", "cp /certs/server.key /certs/server.crt /shared-certs/ 2>/dev/null && chmod 644 /shared-certs/server.key /shared-certs/server.crt || true; exec java -jar driver.jar \"$@\"", "--"]
CMD ["node", "2775"]
