#!/usr/bin/env bash
# Shared bounded history recovery. Source this file; the result is returned in
# VERITY_MERGE_BASE so callers can reuse it without repeating network requests.
verity_resolve_review_base() {
  local base_ref="$1" tip="$2" short remote branch ref source_ref="" attempt
  VERITY_MERGE_BASE=""
  VERITY_BASE_REASON="no common ancestor"
  if VERITY_MERGE_BASE=$(git merge-base "$base_ref" "$tip" 2>/dev/null); then
    return 0
  fi
  VERITY_MERGE_BASE=""
  short="${base_ref#refs/}"
  short="${short#remotes/}"
  remote="${short%%/*}"
  branch="${short#*/}"
  if [ "$remote" = "$short" ] || ! git config --get "remote.$remote.url" >/dev/null 2>&1; then
    VERITY_BASE_REASON="base is not a configured remote-tracking ref"
    return 1
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    VERITY_BASE_REASON="bounded fetch requires timeout"
    return 1
  fi
  # Introducing shallow boundaries into a complete repository can hide
  # ancestors that were already present from the secret and review gates.
  if [ "$(git rev-parse --is-shallow-repository)" != true ]; then
    VERITY_BASE_REASON="base unavailable or unrelated in a complete repository; restore it explicitly"
    return 1
  fi
  # A local tip may never have existed on the remote. Recover its ancestry
  # through a remote-tracking ancestor, rather than fetching an unpublished SHA.
  while IFS= read -r ref; do
    [ "$ref" != "refs/remotes/$remote/HEAD" ] || continue
    if git merge-base --is-ancestor "$ref" "$tip" 2>/dev/null; then
      source_ref="+refs/heads/${ref#refs/remotes/$remote/}:$ref"
      break
    fi
  done < <(git for-each-ref --format='%(refname)' "refs/remotes/$remote/")
  local refs=("+refs/heads/$branch:refs/remotes/$short")
  [ -z "$source_ref" ] || refs+=("$source_ref")
  # At most three requests, each killed after ten seconds (plus one second
  # for termination). Never unshallow the entire repository or fetch all branches.
  for attempt in 1 2 3; do
    local depth=(--deepen=128)
    if ! git rev-parse --verify --quiet "$base_ref" >/dev/null 2>&1; then
      depth=(--depth=128)
    fi
    echo "review-base: recovering history for $base_ref (attempt $attempt/3)…" >&2
    if ! GIT_TERMINAL_PROMPT=0 timeout --kill-after=1s 10s \
      git -c credential.interactive=false fetch --quiet --no-tags --no-recurse-submodules \
      "${depth[@]}" "$remote" "${refs[@]}" >/dev/null 2>&1; then
      VERITY_BASE_REASON="history fetch failed or timed out"
      return 1
    fi
    if VERITY_MERGE_BASE=$(git merge-base "$base_ref" "$tip" 2>/dev/null); then
      return 0
    fi
    VERITY_MERGE_BASE=""
    [ "$(git rev-parse --is-shallow-repository)" = true ] || break
  done
  VERITY_BASE_REASON="no common ancestor within the history recovery limit"
  return 1
}
