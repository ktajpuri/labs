#!/bin/sh
# Network-bound workload: bulk iperf3 transfer to net-server through a
# tc rate-limited egress. The tbf qdisc IS the "link" being saturated —
# container-to-container traffic on one host would otherwise run at
# memory-bus speed and the bottleneck would be CPU, not the network.
#
#   RATE=200mbit DURATION=30 sh /workloads/net_transfer.sh
set -e
RATE=${RATE:-200mbit}
DURATION=${DURATION:-30}

tc qdisc replace dev eth0 root tbf rate "$RATE" burst 64kb latency 400ms
echo "egress capped at $RATE via tc tbf; starting ${DURATION}s transfer"
iperf3 -c net-server -t "$DURATION"
