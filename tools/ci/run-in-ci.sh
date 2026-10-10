#!/usr/bin/env bash
#
# Run a command in a container that matches the CI runner.
#
#   tools/ci/run-in-ci.sh npm test
#   tools/ci/run-in-ci.sh npm run test:browser
#   tools/ci/run-in-ci.sh --shell          # an interactive shell in the container
#
# ## Why this exists
#
# A flaky test passed locally and failed in CI three times, and the difference was
# never reproduced. Guessing at a CI-only cause from a machine that does not
# reproduce it is how a wrong fix gets written, which is exactly what happened.
# This runs the command where CI runs it.
#
# The image is built once and cached. `--rebuild` forces a fresh one.
#
# The Node version comes from `.nvmrc`, the same file the workflow reads, so the
# container and CI cannot disagree about it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="iu-ci"

# The exact patch release for the major in `.nvmrc`. A bare `v24` is not a
# downloadable release, so the latest patch is resolved from Node's own index and
# cached, which also means the container and CI cannot disagree about the major.
MAJOR="$(tr -d '[:space:]v' < "$ROOT/.nvmrc")"
NODE_VERSION="${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json \
  | tr '}' '\n' | grep -o "\"version\":\"v${MAJOR}\.[0-9.]*\"" | head -1 \
  | cut -d'"' -f4 | tr -d 'v')}"

if [[ "${1:-}" == "--rebuild" ]]; then
  shift
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE (Node $NODE_VERSION, Ubuntu 24.04)..." >&2
  docker build \
    --build-arg "NODE_VERSION=$NODE_VERSION" \
    -f "$ROOT/tools/ci/Dockerfile" \
    -t "$IMAGE" \
    "$ROOT" >&2
fi

# `node_modules` is deliberately NOT shared from the host: it is built for the
# host's platform, and reusing it would test a different install than CI makes.
# A named volume keeps the install between runs so a repeat run is fast.
#
# `--init` so a Playwright child process does not become a zombie, and the
# browsers path is set in the image.
COMMON=(
  --rm
  --init
  -v "$ROOT:/repo"
  -v "iu-ci-node-modules:/repo/node_modules"
  -w /repo
  -e CI=true
)

if [[ "${1:-}" == "--shell" ]]; then
  exec docker run "${COMMON[@]}" -it "$IMAGE" bash
fi

if [[ $# -eq 0 ]]; then
  echo "usage: tools/ci/run-in-ci.sh <command...>" >&2
  echo "       tools/ci/run-in-ci.sh --shell" >&2
  exit 2
fi

# `npm ci` first, so what runs is the lockfile's install, as CI does it.
exec docker run "${COMMON[@]}" "$IMAGE" bash -lc "npm ci --silent && $*"
