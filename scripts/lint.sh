#!/usr/bin/env bash
# Full working-tree lint, shared by CI and the local gate. Reset ESLint memory per batch.
set -euo pipefail
lint_options=("$@")
exts=('*.js' '*.jsx' '*.ts' '*.tsx' '*.mjs' '*.cjs' '*.mts' '*.cts')
# CI disables result reuse; local snapshots validate current type dependencies.
# lint-runner.mjs groups the files and recycles a worker per group, releasing the
# complete type graph and parser state; group size depends on the environment.
lint_batched() {
  local label="$1"; shift
  [ "$#" -gt 0 ] || return 0
  echo "::group::eslint $label"
  node scripts/lint-runner.mjs "${lint_options[@]}" -- "$@"
  echo "::endgroup::"
}
for pkg in packages/*; do
  [ -d "$pkg" ] || continue
  files=()
  while IFS= read -r file; do
    if [ -f "$file" ]; then files+=("$file"); fi
  done < <(git ls-files --cached --others --exclude-standard -- "$pkg" \
    | grep -E '\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$' || true)
  [ "${#files[@]}" -gt 0 ] || continue
  lint_batched "$pkg" "${files[@]}"
done
rest=()
while IFS= read -r file; do
  if [ -f "$file" ]; then rest+=("$file"); fi
done < <(git ls-files --cached --others --exclude-standard -- "${exts[@]}" ':!:packages/**')
if [ "${#rest[@]}" -gt 0 ]; then
  lint_batched "(non-package files)" "${rest[@]}"
fi
