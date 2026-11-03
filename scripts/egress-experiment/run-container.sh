#!/usr/bin/env bash
# Run ONLY on an isolated disposable test host. Never mount its Docker socket into the fixture.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'usage: run-container.sh <installed-runtime-name> <existing-image-with-python3-unshare-npm> <new-output-directory>' >&2
  exit 64
fi
runtime_name=$1
fixture_image=$2
result_dir=$3
command -v docker >/dev/null
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -- "$result_dir"
result_dir=$(cd -- "$result_dir" && pwd)
container_name="verity-egress-probe-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# --pull=never makes this a local fixture run with no registry traffic.
# Record this reduced launch profile; it is not production equivalence by itself.
docker image inspect "$fixture_image" --format '{{.Id}}' > "$result_dir/image-id.txt"
docker info --format '{{json .Runtimes}}' > "$result_dir/runtimes.json"
docker create --name "$container_name" --pull=never --runtime "$runtime_name" \
  --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --network none --memory 256m --cpus 1 --pids-limit 64 \
  --mount "type=bind,src=$script_dir,dst=/probe,readonly" \
  --mount "type=bind,src=$result_dir,dst=/results" \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m \
  --entrypoint python3 "$fixture_image" /probe/probe.py --output /results/result.json >/dev/null
# Avoid inspecting arbitrary environment variables or other containers.
docker inspect "$container_name" --format '{{json .HostConfig}}' > "$result_dir/launch.json"
set +e
timeout 90 docker start -a "$container_name" > "$result_dir/stdout.txt" 2> "$result_dir/stderr.txt"
attach_status=$?
set -e
if [[ $attach_status != 0 ]]; then
  exit "$attach_status"
fi
docker inspect "$container_name" --format '{{.State.ExitCode}}' > "$result_dir/exit-code.txt"
exit "$(cat "$result_dir/exit-code.txt")"
