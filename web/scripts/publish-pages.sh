#!/usr/bin/env bash
# Publish the web app to GitHub Pages (branch gh-pages, served at /rust-and-barter/).
# A plain push of a new commit on gh-pages; no Actions minutes needed.
set -euo pipefail
cd "$(dirname "$0")/.."
VITE_BASE=/rust-and-barter/ npm run build
src=$(pwd)/dist; rev=$(git rev-parse --short HEAD); url=$(git remote get-url origin)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git clone -q -b gh-pages "$url" "$tmp"
cd "$tmp" && git rm -rq --ignore-unmatch . && cp -r "$src"/. . && touch .nojekyll
git add -A && git commit -qm "Built web/ for Pages from main $rev" && git push -q origin gh-pages
echo "published $rev"
