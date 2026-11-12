#!/usr/bin/env bash
# Copies the parts of the real app the site reuses: the living-diagram renderer and
# event model (for the hero animation), a recorded run, and the interface itself
# (which runs in browser-preview mode for the live demo). Run before previewing or deploying.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf js/vendor data app
mkdir -p js/vendor data app
cp ../ui/js/util.js ../ui/js/model.js ../ui/js/diagram.js js/vendor/
cp ../ui/mock/sample-run.json data/
cp -r ../ui/. app/
echo "site assets ready"
