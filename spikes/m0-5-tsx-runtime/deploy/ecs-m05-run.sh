#!/bin/sh
set -eu
root=/opt/mini-atoms-spikes/m05-shell-v1
status_file=/opt/mini-atoms-spikes/m05-shell-v1-status.txt
stage=starting
trap 'task_exit=$?; printf "EXIT_CODE=%s STAGE=%s\n" "$task_exit" "$stage" > "$status_file"' EXIT
cd "$root"
mkdir -p evidence artifacts .local/bin
chown 1001:1001 evidence artifacts
export SPIKE_ENV=ECS
stage=build
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
docker compose -f deploy/compose.yml --progress plain build compiler > evidence/build-ecs.log 2>&1
stage=compiler
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
docker compose -f deploy/compose.yml run --rm --no-deps -T -e SPIKE_ENV=ECS compiler npm run test:build > evidence/t1-ecs.log 2>&1
docker compose -f deploy/compose.yml run --rm --no-deps -T -e SPIKE_ENV=ECS compiler npm run build:fixtures > evidence/fixtures-ecs.log 2>&1
# Export only the trusted image's Node binary for host-side Docker orchestration.
task_container=$(docker create --network none mini-atoms-m05:local)
docker cp "$task_container:/usr/bin/node" .local/bin/node
docker rm "$task_container" >/dev/null
chmod 0755 .local/bin/node
.local/bin/node --version > evidence/controller-node-version.txt
sha256sum .local/bin/node > evidence/controller-node-sha256.txt
.local/bin/node tests/compare-fixtures.mjs > evidence/cross-builds-ecs.log 2>&1
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1001:1001 \
  -v "$root/runtime-hashes.json:/expected-runtime-hashes.json:ro" mini-atoms-m05:local node --input-type=module -e '
import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; import assert from "node:assert/strict";
const hashes=JSON.parse(readFileSync("/expected-runtime-hashes.json","utf8"));
for(const [name, expected] of Object.entries(hashes)) assert.equal(createHash("sha256").update(readFileSync(name)).digest("hex"), expected, name);
console.log(JSON.stringify({status:"PASS",hashes}));
' > evidence/runtime-files-ecs.json
stage=t2
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
.local/bin/node src/spike-cli/run.mjs --gate t2 > evidence/t2-ecs.log 2>&1
.local/bin/node tests/preview-headers.mjs > evidence/preview-headers-ecs.log 2>&1
stage=t3
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
.local/bin/node src/spike-cli/run.mjs --gate t3 > evidence/t3-ecs.log 2>&1
stage=resources
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
.local/bin/node tests/resources-with-stats.mjs > evidence/resources-ecs.log 2>&1
stage=collect
printf 'RUNNING STAGE=%s\n' "$stage" > "$status_file"
docker image inspect mini-atoms-m05:local --format '{{.Id}}' > evidence/docker-image-id.txt
docker compose -f deploy/compose.yml ps --format json > evidence/containers-ecs.json
docker version --format '{{json .}}' > evidence/docker-version-ecs.json
docker compose version > evidence/compose-version-ecs.txt
uname -a > evidence/uname-ecs.txt
free -h > evidence/memory-ecs.txt
df -h / > evidence/disk-ecs.txt
ss -lntp > evidence/listeners-ecs.txt
curl -fsS http://127.0.0.1:8091/healthz > evidence/health-ecs.json
stage=completed
printf 'M05_ECS_CORE_COMMANDS_COMPLETED\n'
