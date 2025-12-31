#!/bin/bash
set -e

echo "=== pds e2e tests ==="
echo ""

# Run individual test suites
/app/test/e2e/test-global.sh
/app/test/e2e/test-project.sh

echo ""
echo "=== All e2e tests passed! ==="
