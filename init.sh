#!/usr/bin/env bash
set -euo pipefail

npm install
npm run typecheck
npm test
npm run lint
