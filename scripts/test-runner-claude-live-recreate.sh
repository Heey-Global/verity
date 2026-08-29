#!/usr/bin/env bash
set -euo pipefail

image="${VERITY_LIVE_SMOKE_IMAGE:-verity-sandbox:smoke}"
repo_source="${VERITY_LIVE_SMOKE_REPO_SOURCE:-$(pwd)}"
suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
network="verity-claude-recreate-$suffix"
postgres="verity-claude-recreate-postgres-$suffix"
sandbox="verity-claude-recreate-sandbox-$suffix"
server_seed="verity-claude-recreate-seed-$suffix"
server_resume="verity-claude-recreate-resume-$suffix"
runtime_volume="verity-claude-recreate-runtime-$suffix"
work_volume="verity-claude-recreate-work-$suffix"

cleanup() {
  docker rm -f "$server_seed" "$server_resume" "$sandbox" "$postgres" >/dev/null 2>&1 || true
  docker volume rm -f "$runtime_volume" "$work_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$network" >/dev/null
docker volume create "$work_volume" >/dev/null
db_password="$(openssl rand -hex 24)"
docker run -d --name "$postgres" --network "$network" \
  -e POSTGRES_USER=verity -e POSTGRES_DB=verity -e POSTGRES_PASSWORD="$db_password" \
  postgres:18-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$postgres" sh -c \
    'test "$(cat /proc/1/comm)" = postgres && psql -U verity -d verity -Atqc "SELECT 1" | grep -qx 1' \
    >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$postgres" sh -c \
  'test "$(cat /proc/1/comm)" = postgres && psql -U verity -d verity -Atqc "SELECT 1" | grep -qx 1' \
  >/dev/null

postgres_url="postgresql://verity:$db_password@$postgres:5432/verity"

start_sandbox() {
  docker volume create "$runtime_volume" >/dev/null
  docker run --rm --user 0:0 -v "$runtime_volume:/runtime" -v "$work_volume:/work" \
    --entrypoint=sh "$image" \
    -c 'chown 1000:1101 /runtime /work && chmod 0170 /runtime && chmod 0750 /work'
  docker run -d --name "$sandbox" --network "$network" \
    -e WORKSPACE=/work -e VERITY_LIVE_SMOKE_WORKTREE=/work \
    -e CLAUDE_CONFIG_DIR=/run/verity-runner/claude \
    -v "$runtime_volume:/run/verity-runner" -v "$work_volume:/work" \
    "$image" >/dev/null
  docker cp scripts/fixtures/fake-claude-recreate-smoke.mjs "$sandbox:/tmp/claude-recreate-smoke"
  docker exec --user 0:0 "$sandbox" \
    install -m 0755 /tmp/claude-recreate-smoke /usr/local/bin/claude
  docker exec -d --user 0:0 "$sandbox" verity-runner-stack-start
  for _ in $(seq 1 60); do
    docker exec "$sandbox" test -S /run/verity-runner/supervisor.sock 2>/dev/null && break
    sleep 1
  done
  docker exec "$sandbox" test -S /run/verity-runner/supervisor.sock
}

server_args=(--network "$network" --user 1000:1000 --group-add 1101 -w /repo
  -e "VERITY_LIVE_SMOKE_POSTGRES_URL=$postgres_url"
  -v "$repo_source:/repo:ro" -v "$runtime_volume:/runtime" -v "$work_volume:/work"
  node:24-bookworm-slim node packages/server/dist/runner-claude-recreate-server.js)

start_sandbox
docker run --name "$server_seed" "${server_args[@]}" seed

# The recreate boundary is real: remove the whole Sandbox and its Runner runtime,
# then allocate a fresh volume. Only PostgreSQL and the project worktree survive.
docker rm -f "$sandbox" >/dev/null
docker rm -f "$server_seed" >/dev/null
docker volume rm "$runtime_volume" >/dev/null
start_sandbox
docker exec "$sandbox" test ! -e \
  "/run/verity-runner/claude/projects/-work/$(docker run --rm -v "$work_volume:/work:ro" busybox:1.37 cat /work/backend-session-id).jsonl"

# Rebuild args so the new Server bind-mounts the newly-created runtime volume.
server_args=(--network "$network" --user 1000:1000 --group-add 1101 -w /repo
  -e "VERITY_LIVE_SMOKE_POSTGRES_URL=$postgres_url"
  -v "$repo_source:/repo:ro" -v "$runtime_volume:/runtime" -v "$work_volume:/work"
  node:24-bookworm-slim node packages/server/dist/runner-claude-recreate-server.js)
docker run --name "$server_resume" "${server_args[@]}" resume

test "$(docker run --rm -v "$work_volume:/work:ro" busybox:1.37 \
  sh -c 'wc -l </work/recreate-observed.json')" -eq 1
echo 'Claude live Sandbox recreate smoke passed'
