#!/usr/bin/env bash
set -euo pipefail

image="${VERITY_LIVE_SMOKE_IMAGE:-verity-sandbox:smoke}"
suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
network="verity-claude-live-$suffix"
postgres="verity-claude-live-postgres-$suffix"
sandbox="verity-claude-live-sandbox-$suffix"
server_a="verity-claude-live-server-a-$suffix"
server_b="verity-claude-live-server-b-$suffix"
runtime_volume="verity-claude-live-runtime-$suffix"
work_volume="verity-claude-live-work-$suffix"

cleanup() {
  docker rm -f "$server_a" "$server_b" "$sandbox" "$postgres" >/dev/null 2>&1 || true
  docker volume rm -f "$runtime_volume" "$work_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# Every assertion routes through fail(): a bare `test`/`grep -q` death leaves
# a zero-output CI log that cannot be diagnosed (a Server killed pre-output —
# e.g. OOM — used to fail this script in complete silence).
fail() {
  echo "live-smoke FAILED: $*" >&2
  docker ps -a --filter "name=$suffix" >&2 || true
  for c in "$postgres" "$sandbox" "$server_a" "$server_b"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      echo "--- $c state:" >&2
      docker inspect -f '{{json .State}}' "$c" >&2 || true
      echo "--- $c logs:" >&2
      docker logs "$c" >&2 || true
    fi
  done
  echo "--- stack-start log:" >&2
  docker exec "$sandbox" sh -c 'cat /tmp/stack-start.log' >&2 || true
  echo "--- spawn-broker log:" >&2
  docker exec "$sandbox" sh -c \
    'sed -n "1,160p" /run/verity-runner-broker/agent-spawn-broker.log' >&2 || true
  echo "--- events.jsonl:" >&2
  docker run --rm -v "$runtime_volume:/runtime:ro" busybox:1.37 \
    sh -c 'cat /runtime/turns/claude-live-container-turn/events.jsonl' >&2 || true
  echo "--- claude-invocations.jsonl:" >&2
  docker run --rm -v "$work_volume:/work:ro" busybox:1.37 \
    sh -c 'cat /work/claude-invocations.jsonl' >&2 || true
  exit 1
}

docker network create "$network" >/dev/null
docker volume create "$runtime_volume" >/dev/null
docker volume create "$work_volume" >/dev/null
# Mirror Provisioner.prepareRunnerRuntime(): the Server owns the runtime inode,
# the Runner gets group read/write, and the agent uid gets traverse-only access
# to the separately owned Claude transcript directory created by stack-start.
docker run --rm --user 0:0 -v "$runtime_volume:/runtime" -v "$work_volume:/work" \
  --entrypoint=sh "$image" \
  -c 'chown 1000:1101 /runtime && chmod 0170 /runtime && chown 1000:1000 /work && chmod 0750 /work'
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
  >/dev/null \
  || fail "postgres never became ready"

docker run -d --name "$sandbox" --network "$network" \
  -e WORKSPACE=/work -e VERITY_LIVE_SMOKE_WORKTREE=/work \
  -e ANTHROPIC_API_KEY=must-not-cross -e CLAUDE_CODE_OAUTH_TOKEN=must-not-cross \
  -e DOPPLER_TOKEN=must-not-cross \
  -e GITHUB_TOKEN=must-not-cross \
  -v "$runtime_volume:/run/verity-runner" -v "$work_volume:/work" \
  "$image" >/dev/null
docker cp scripts/fixtures/fake-claude-live-smoke.mjs "$sandbox:/tmp/claude-live-smoke"
docker exec --user 0:0 "$sandbox" \
  install -m 0755 /tmp/claude-live-smoke /usr/local/bin/claude
# Detached: its output is otherwise lost forever, so capture it to a file
# that fail() can dump.
docker exec -d --user 0:0 "$sandbox" \
  sh -c 'verity-runner-stack-start >/tmp/stack-start.log 2>&1'
for _ in $(seq 1 60); do
  docker exec "$sandbox" test -S /run/verity-runner/supervisor.sock 2>/dev/null && break
  sleep 1
done
docker exec "$sandbox" test -S /run/verity-runner/supervisor.sock \
  || fail "supervisor socket never appeared"

postgres_url="postgresql://verity:$db_password@$postgres:5432/verity"
server_args=(--network "$network" --group-add 1101 -w /repo
  -e "VERITY_LIVE_SMOKE_POSTGRES_URL=$postgres_url"
  -v "$(pwd):/repo:ro" -v "$runtime_volume:/runtime" -v "$work_volume:/work"
  node:24-bookworm-slim node packages/server/dist/runner-claude-live-server.js)

docker run -d --name "$server_a" "${server_args[@]}" start >/dev/null
for _ in $(seq 1 120); do
  docker logs "$server_a" 2>&1 | grep -qx READY && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$server_a")" != true ]; then
    fail "Server A exited before READY"
  fi
  sleep 0.25
done
docker logs "$server_a" 2>&1 | grep -qx READY \
  || fail "Server A never printed READY"

docker kill "$server_a" >/dev/null
docker run --rm -v "$work_volume:/work" busybox:1.37 sh -c 'printf continue >/work/continue'
for _ in $(seq 1 120); do
  if docker run --rm -v "$runtime_volume:/runtime:ro" busybox:1.37 \
    grep -q '"kind":"result"' /runtime/turns/claude-live-container-turn/events.jsonl 2>/dev/null; then
    break
  fi
  sleep 0.25
done
docker run --rm -v "$runtime_volume:/runtime:ro" busybox:1.37 \
  grep -q '"kind":"result"' /runtime/turns/claude-live-container-turn/events.jsonl \
  || fail "agent never wrote a terminal result frame after the Server kill"

docker run --name "$server_b" "${server_args[@]}" reattach \
  || fail "reattach Server exited non-zero"
invocations="$(docker run --rm -v "$work_volume:/work:ro" busybox:1.37 \
  sh -c 'wc -l </work/claude-invocations.jsonl')" \
  || fail "could not read claude-invocations.jsonl"
test "$invocations" -eq 1 \
  || fail "expected exactly one claude invocation, got: $invocations"
docker run --rm -v "$work_volume:/work:ro" busybox:1.37 \
  grep -q '"credentialBoundary":"no-credentials"' /work/claude-invocations.jsonl \
  || fail "Claude process did not attest the credential-free boundary"
echo 'Claude ACP live managed-container restart smoke passed'
