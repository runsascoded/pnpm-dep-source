#!/bin/bash
set -e

echo "--- Testing global installs ---"

# Test: pds is installed
echo "Test: pds --version"
pds --version

# Test: Initialize global config
echo ""
echo "Test: pds init -g"
pds init /mock-dep -g -H test-org/mock-dep
cat ~/.config/pnpm-dep-source/config.json

# Verify global config was created
if [ ! -f ~/.config/pnpm-dep-source/config.json ]; then
  echo "FAIL: Global config not created"
  exit 1
fi
echo "PASS: Global config created"

# Test: pds ls -g
echo ""
echo "Test: pds ls -g"
pds ls -g | tee /tmp/ls-output.txt
if ! grep -q "@test/mock-dep" /tmp/ls-output.txt; then
  echo "FAIL: pds ls -g doesn't show mock-dep"
  exit 1
fi
echo "PASS: pds ls -g shows mock-dep"

# Test: pds l -g (local global install)
echo ""
echo "Test: pds l -g"
pds l -g
pnpm list -g @test/mock-dep | tee /tmp/global-list.txt
if ! grep -q "mock-dep" /tmp/global-list.txt; then
  echo "FAIL: Global local install failed"
  exit 1
fi
echo "PASS: pds l -g works"

# Test: pds status -g
echo ""
echo "Test: pds status -g"
pds status -g | tee /tmp/status-output.txt
if ! grep -q "local" /tmp/status-output.txt; then
  echo "FAIL: pds status -g doesn't show local"
  exit 1
fi
echo "PASS: pds status -g works"

# Test: pds info
echo ""
echo "Test: pds info"
pds info | tee /tmp/info-output.txt
if ! grep -q "pnpm-dep-source" /tmp/info-output.txt; then
  echo "FAIL: pds info failed"
  exit 1
fi
echo "PASS: pds info works"

echo ""
echo "--- Global install tests passed ---"
