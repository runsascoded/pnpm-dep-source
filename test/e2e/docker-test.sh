#!/bin/bash
set -e

cd "$(dirname "$0")/../.."

echo "Building pds..."
pnpm build

echo "Building Docker image..."
docker build -t pds-e2e -f test/e2e/Dockerfile .

echo "Running e2e tests..."
docker run --rm pds-e2e
