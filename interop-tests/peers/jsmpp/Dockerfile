# jsmpp has no published artifact for this pin; cloned at a fixed commit and installed into the
# local Maven repo, which the driver build below then depends on.
FROM maven:3.9.11-eclipse-temurin-21 AS jsmpp-source

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*

ARG JSMPP_COMMIT=a24db96ad7014cdc84a3eebfa64a75c362daef2a

RUN git clone https://github.com/opentelecoms-org/jsmpp.git /src \
	&& cd /src \
	&& git checkout "${JSMPP_COMMIT}" \
	&& mvn -q -pl jsmpp -am install -DskipTests -Dgpg.skip=true

FROM maven:3.9.11-eclipse-temurin-21 AS build

COPY --from=jsmpp-source /root/.m2 /root/.m2

WORKDIR /driver
COPY pom.xml .
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21.0.8_9-jre-jammy AS runtime

WORKDIR /app
COPY --from=build /driver/target/driver.jar ./driver.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "driver.jar"]
CMD ["node", "2775"]
