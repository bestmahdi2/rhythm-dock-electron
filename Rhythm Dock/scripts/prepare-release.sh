#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
version=$(node "$script_dir/release-artifacts.js" version)
tag="v${version#version=}"
echo 'publish=false' >> "$GITHUB_OUTPUT"

if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
  git fetch origin "refs/tags/$tag:refs/tags/$tag"
  test "$(git rev-list -n 1 "$tag")" = "$GITHUB_SHA"
  echo 'publish=true' >> "$GITHUB_OUTPUT"
  exit 0
fi
if [[ "$GITHUB_REF" != refs/heads/master ]]; then
  exit 0
fi

# Listing refs distinguishes absence from permission/network errors; failures stop
# the job instead of being mistaken for a missing tag.
existing=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$tag" --jq ".[] | select(.ref == \"refs/tags/$tag\") | .object.sha")
if [[ -n "$existing" ]]; then
  git fetch origin "refs/tags/$tag:refs/tags/$tag"
  if [[ "$(git rev-list -n 1 "$tag")" == "$GITHUB_SHA" ]]; then
    echo 'publish=true' >> "$GITHUB_OUTPUT"
  else
    echo "Release tag $tag belongs to a different commit. Build artifacts will still be available; bump the version to publish again." >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
fi

head=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/master" --jq '.object.sha')
if [[ "$head" != "$GITHUB_SHA" ]]; then
  echo 'A newer commit reached master before tag reservation. This run will build artifacts only.' >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# GITHUB_TOKEN cannot tag some older workflow-changing commits. Reserve while
# this run is still the default branch head, not after all platform builds finish.
gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/tags/$tag" -f "sha=$GITHUB_SHA" >/dev/null
echo 'publish=true' >> "$GITHUB_OUTPUT"
echo "Reserved $tag at $GITHUB_SHA. The release is published only after tests and every package build succeed." >> "$GITHUB_STEP_SUMMARY"
