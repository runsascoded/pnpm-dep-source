#!/bin/bash
set -e

cd "$(dirname "$0")/../.."

echo "Building Docker image..."
docker build -t pds-e2e -f test/e2e/Dockerfile .

echo "Running e2e tests..."
gh_token="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [ -n "$gh_token" ]; then
  docker run --rm -e GH_TOKEN="$gh_token" pds-e2e
else
  echo "Warning: No GH_TOKEN available; 'init from URL' tests will be skipped"
  docker run --rm pds-e2e
fi
