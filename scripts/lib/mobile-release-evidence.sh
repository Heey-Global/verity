#!/usr/bin/env bash
set -euo pipefail

mode="$1"
directory="$2"
payload="$directory/native-staging.json"
signature="$directory/native-staging.sigstore.json"
bundle="$directory/native-staging.provenance.sigstore.json"
provenance="$directory/native-staging.intoto.jsonl"
identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/mobile-native-build.yml@refs/heads/main"
[[ "$MOBILE_TAG" =~ ^mobile-v[0-9]+\.[0-9]+\.0$ ]]
[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]]
jq -e --arg source "$SOURCE_REVISION" --arg version "${MOBILE_TAG#mobile-v}" \
  '.schema == 1 and .product == "mobile-native" and .source == $source and .version == $version' "$payload" >/dev/null

if [[ "$mode" == sign ]]; then
  [[ "$GITHUB_REF" == refs/heads/main ]]
  # This attests the build record, not the IPA uploaded to App Store Connect.
  jq -n --arg source "$SOURCE_REVISION" --arg repository "$GITHUB_REPOSITORY" \
    --arg tag "$MOBILE_TAG" --arg identity "$identity" \
    --arg invocation "https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}" \
    '{buildDefinition:{buildType:"https://github.com/Heey-Global/verity/mobile-staging-record/v1",externalParameters:{tag:$tag},resolvedDependencies:[{uri:("git+https://github.com/"+$repository),digest:{gitCommit:$source}}]},runDetails:{builder:{id:$identity},metadata:{invocationId:$invocation}}}' \
    > "$directory/native-staging.predicate.json"
  cosign sign-blob --yes --bundle "$signature" "$payload"
  cosign attest-blob --yes --type slsaprovenance1 --predicate "$directory/native-staging.predicate.json" --bundle "$bundle" "$payload"
  jq -c '.dsseEnvelope' "$bundle" > "$provenance"
elif [[ "$mode" != verify ]]; then
  exit 1
fi

for file in "$signature" "$bundle" "$provenance"; do test -s "$file"; done
cosign verify-blob --bundle "$signature" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository "$GITHUB_REPOSITORY" \
  --certificate-github-workflow-ref refs/heads/main "$payload"
cosign verify-blob-attestation --type slsaprovenance1 --bundle "$bundle" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository "$GITHUB_REPOSITORY" \
  --certificate-github-workflow-ref refs/heads/main "$payload"
# The published envelope must be the exact envelope verified in the bundle.
jq -e --slurpfile envelope "$provenance" '.dsseEnvelope == $envelope[0] and ($envelope | length) == 1' "$bundle" >/dev/null
jq -r '.payload' "$provenance" | base64 --decode | jq -e \
  --arg source "$SOURCE_REVISION" --arg tag "$MOBILE_TAG" --arg identity "$identity" \
  --arg repository "git+https://github.com/${GITHUB_REPOSITORY}" \
  '.predicateType == "https://slsa.dev/provenance/v1" and
   .predicate.buildDefinition.buildType == "https://github.com/Heey-Global/verity/mobile-staging-record/v1" and
   .predicate.buildDefinition.externalParameters.tag == $tag and
   .predicate.buildDefinition.resolvedDependencies == [{uri:$repository,digest:{gitCommit:$source}}] and
   .predicate.runDetails.builder.id == $identity' >/dev/null
