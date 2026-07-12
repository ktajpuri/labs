FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps sysstat htop iperf3 iproute2 iftop \
    && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
