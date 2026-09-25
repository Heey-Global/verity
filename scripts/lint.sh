#!/usr/bin/env bash
# Full tracked-tree lint, shared by CI and the local gate. Reset ESLint memory per batch.
set -euo pipefail
exts=('*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs' '*.mts' '*.cts')
# No --cache here either; unchanged consumers must be checked against current types.
eslint_opts=(--no-warn-ignored)
batch=64
lint_batched() {
  local label="$1"; shift
  local -a all=("$@")
  local i part=1
  for ((i = 0; i < ${#all[@]}; i += batch)); do
    echo "::group::eslint $label ($part)"
    npx eslint "${eslint_opts[@]}" -- "${all[@]:i:batch}"
    echo "::endgroup::"
    part=$((part + 1))
  done
}
for pkg in packages/*; do
  [ -d "$pkg" ] || continue
  files=()
  while IFS= read -r file; do files+=("$file"); done < <(git ls-files -- "$pkg" \
    | grep -E '\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$' || true)
  [ "${#files[@]}" -gt 0 ] || continue
  lint_batched "$pkg" "${files[@]}"
done
rest=()
while IFS= read -r file; do rest+=("$file"); done < <(git ls-files "${exts[@]}" ':!:packages/**')
if [ "${#rest[@]}" -gt 0 ]; then
  lint_batched "(non-package files)" "${rest[@]}"
fi
