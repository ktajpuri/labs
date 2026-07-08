# Flink + the SQL Kafka connector (not bundled in the base image).
# flink-json (the JSON format) IS bundled in /opt/flink/lib already.
FROM flink:1.20.0-scala_2.12-java17

USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fSL -o /opt/flink/lib/flink-sql-connector-kafka-3.3.0-1.20.jar \
      https://repo1.maven.org/maven2/org/apache/flink/flink-sql-connector-kafka/3.3.0-1.20/flink-sql-connector-kafka-3.3.0-1.20.jar \
 && chmod 644 /opt/flink/lib/flink-sql-connector-kafka-3.3.0-1.20.jar
USER flink
