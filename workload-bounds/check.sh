#!/bin/sh
# Steady-state check — run this before EVERY experiment.
# Pass = all 6 containers Up, VM CPU mostly idle (us+sy < 10, wa ~ 0),
# no swap traffic (si/so = 0), disk %util ~ 0, swap space available.
set -e
cd "$(dirname "$0")"

echo "== containers =="
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

echo
echo "== vmstat 1 3 (want: us+sy low, wa 0, si/so 0) =="
docker compose exec -T observer vmstat 1 3

echo
echo "== iostat -x (want: %util near 0 on the vd*/sd* device) =="
docker compose exec -T observer iostat -x 1 2 | tail -20

echo
echo "== free -m (swap total must be > 0 for scenario 4) =="
docker compose exec -T observer free -m
