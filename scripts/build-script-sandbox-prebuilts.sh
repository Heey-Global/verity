#!/usr/bin/env bash
# Build the two release artifacts from one pinned compiler image. The output is
# intentionally generated only in trusted CI/release jobs; target images never
# receive a compiler and never attest bytes they compiled themselves.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
feature="$root/features/verity-sandbox-toolkit"
output="$feature/prebuilt"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

docker buildx build \
  --platform linux/amd64 \
  --file "$output/Dockerfile" \
  --output "type=local,dest=$staging" \
  "$feature"

install -D -m 0755 "$staging/linux-amd64/verity-script-sandbox" \
  "$output/linux-amd64/verity-script-sandbox"
install -D -m 0755 "$staging/linux-arm64/verity-script-sandbox" \
  "$output/linux-arm64/verity-script-sandbox"
(
  cd "$output"
  sha256sum linux-amd64/verity-script-sandbox linux-arm64/verity-script-sandbox \
    > sha256sums.txt
)
