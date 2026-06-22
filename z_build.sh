#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 18

[ -d node_modules ] || npm install

npm run build:update-libs       # vendor libs -> popup/lib
npm run build:bundle            # esbuild bundle + minify popup/js, popup/css
npm run build:create-dist       # copy manifest + assets -> dist/chrome (+ dist/chrome.zip)
