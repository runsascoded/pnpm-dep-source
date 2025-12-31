#!/bin/bash
set -e

echo "--- Testing project-level installs ---"

cd /test-project

# Setup test project
echo '{"name": "test-project", "version": "1.0.0", "dependencies": {"@test/mock-dep": "^1.0.0"}}' > package.json

# Test: Initialize local config
echo "Test: pds init (local)"
node /app/dist/cli.js init /mock-dep -H test-org/mock-dep
cat .pnpm-dep-source.json

if [ ! -f .pnpm-dep-source.json ]; then
  echo "FAIL: Local config not created"
  exit 1
fi
echo "PASS: Local config created"

# Test: pds ls
echo ""
echo "Test: pds ls"
node /app/dist/cli.js ls | tee /tmp/ls-local.txt
if ! grep -q "@test/mock-dep" /tmp/ls-local.txt; then
  echo "FAIL: pds ls doesn't show mock-dep"
  exit 1
fi
echo "PASS: pds ls works"

# Test: pds local (switch to workspace)
echo ""
echo "Test: pds local -I"
node /app/dist/cli.js local -I

# Check package.json updated
if ! grep -q "workspace:\*" package.json; then
  echo "FAIL: package.json not updated to workspace:*"
  exit 1
fi
echo "PASS: package.json updated"

# Check pnpm-workspace.yaml created
if [ ! -f pnpm-workspace.yaml ]; then
  echo "FAIL: pnpm-workspace.yaml not created"
  exit 1
fi
echo "PASS: pnpm-workspace.yaml created"

# Test: pds status
echo ""
echo "Test: pds status"
node /app/dist/cli.js status | tee /tmp/status-local.txt
if ! grep -q "local" /tmp/status-local.txt; then
  echo "FAIL: pds status doesn't show local"
  exit 1
fi
echo "PASS: pds status works"

# Test: pds github (switch to github ref)
echo ""
echo "Test: pds github main -I"
node /app/dist/cli.js github main -I

# Check package.json updated
if ! grep -q "github:test-org/mock-dep#main" package.json; then
  echo "FAIL: package.json not updated to github ref"
  exit 1
fi
echo "PASS: package.json updated to github"

# Check pnpm-workspace.yaml removed
if [ -f pnpm-workspace.yaml ]; then
  echo "FAIL: pnpm-workspace.yaml should be removed"
  exit 1
fi
echo "PASS: pnpm-workspace.yaml removed"

# Test: pds npm (switch to npm version)
echo ""
echo "Test: pds npm 2.0.0 -I"
node /app/dist/cli.js npm 2.0.0 -I

# Check package.json updated
if ! grep -q '"\^2.0.0"' package.json; then
  echo "FAIL: package.json not updated to npm version"
  exit 1
fi
echo "PASS: package.json updated to npm"

# Test: round-trip back to local
echo ""
echo "Test: round-trip local -> github -> local"
node /app/dist/cli.js local -I
if ! grep -q "workspace:\*" package.json; then
  echo "FAIL: round-trip failed"
  exit 1
fi
echo "PASS: round-trip works"

echo ""
echo "--- Project-level tests passed ---"
