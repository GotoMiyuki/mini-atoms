#!/bin/sh
set -eu
printf 'RUNNING\n' > /opt/mini-atoms-spikes/m0-status.txt
trap 'task_exit=$?; printf "EXIT_CODE=%s\n" "$task_exit" > /opt/mini-atoms-spikes/m0-status.txt' EXIT
cd /opt/mini-atoms-spikes/m0
mkdir -p evidence
chown 1001:1001 evidence
docker compose --progress plain build > evidence/build-ecs.log 2>&1
SPIKE_ENV=ECS docker compose run --rm -e TEST_ENVIRONMENT=ECS-ALIYUN spike npm run verify > evidence/test-ecs.log 2>&1
SPIKE_ENV=ECS docker compose run --rm -e TEST_ENVIRONMENT=ECS-ALIYUN spike npm run test:guards > evidence/guards-ecs.log 2>&1
docker compose up -d --wait > evidence/preview-ecs.log 2>&1
docker compose ps --format json > evidence/containers-ecs.json
docker image inspect mini-atoms-m0:local --format '{{.Id}}' > evidence/image-id-ecs.txt
curl -fsS http://127.0.0.1:8080/healthz > evidence/health-ecs.json
printf 'M0_ECS_COMMANDS_COMPLETED\n'
