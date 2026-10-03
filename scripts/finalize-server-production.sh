set -euo pipefail
gh release view "$TAG" --json isDraft --jq .isDraft >/dev/null
# Artifact-only bridges have no release-please PR; publish their pinned
# draft without reconciling labels or marking them as the latest release.
# release-please normally replaces this label while creating the
# release. Recovery publishes an already-created draft without running
# that action. Move the label first, then roll it back if publication
# fails so either state remains retryable: pending+draft or tagged+public.
if [ "${ARTIFACT_ONLY:-false}" != true ]; then
  version="${TAG#v}"
  pr_numbers="$(gh api --paginate \
    "repos/${GITHUB_REPOSITORY}/pulls?state=closed&per_page=100" --jq \
    '.[] | select(.merged_at != null and .title == "chore(main): release server '"$version"'") | .number')"
  pr_count="$(awk 'NF { count++ } END { print count + 0 }' <<< "$pr_numbers")"
  if [ "$pr_count" -ne 1 ]; then
    echo "::error::Expected exactly one release PR for $TAG, found $pr_count." >&2
    exit 1
  fi
  pr_number="$pr_numbers"
  require_release_labels() {
    expected_pending="$1"
    expected_tagged="$2"
    labels="$(gh api \
      "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels" --jq '.[].name')"
    pending=false
    tagged=false
    grep -Fxq 'autorelease: pending' <<< "$labels" && pending=true
    grep -Fxq 'autorelease: tagged' <<< "$labels" && tagged=true
    if [ "$pending" != "$expected_pending" ] || [ "$tagged" != "$expected_tagged" ]; then
      echo "::error::Release PR labels are pending=$pending tagged=$tagged; expected pending=$expected_pending tagged=$expected_tagged." >&2
      return 1
    fi
  }
  labels="$(gh api \
    "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels" --jq '.[].name')"
  pending=false
  tagged=false
  grep -Fxq 'autorelease: pending' <<< "$labels" && pending=true
  grep -Fxq 'autorelease: tagged' <<< "$labels" && tagged=true
  if [ "$pending" = false ] && [ "$tagged" = false ]; then
    echo "::error::Release PR has neither pending nor tagged label." >&2
    exit 1
  fi
  if [ "$tagged" = false ]; then
    gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels" \
      -f 'labels[]=autorelease: tagged'
  fi
  if [ "$pending" = true ]; then
    # Both labels means an earlier attempt stopped after the idempotent
    # add. Removing pending resumes that transition safely.
    gh api --method DELETE \
      "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels/autorelease%3A%20pending"
  fi
  require_release_labels false true

  publish_status=0
  gh release edit "$TAG" --draft=false --prerelease=false --latest=false || publish_status=$?
  lookup_status=0
  is_draft="$(gh release view "$TAG" --json isDraft --jq '.isDraft')" || lookup_status=$?
  if [ "$lookup_status" -ne 0 ]; then
    # Leave tagged-only in place: the release edit may have succeeded,
    # and the next recovery attempt can safely resume this state.
    exit "$lookup_status"
  fi
  if [ "$is_draft" = "true" ]; then
    gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels" \
      -f 'labels[]=autorelease: pending'
    gh api --method DELETE \
      "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels/autorelease%3A%20tagged" || delete_status=$?
    require_release_labels true false
    [ "$publish_status" -ne 0 ] || publish_status=1
    exit "${publish_status:-1}"
  fi
  is_prerelease="$(gh release view "$TAG" --json isPrerelease --jq '.isPrerelease')"
  if [ "$is_prerelease" != false ]; then
    echo '::error::Production release is still a prerelease; retry finalization.' >&2
    exit 1
  fi
  require_release_labels false true
else
  gh release edit "$TAG" --draft=false --prerelease=false --latest=false
fi
