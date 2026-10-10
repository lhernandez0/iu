# A container that reproduces CI, so a test can be run against the environment
# that actually runs it.
#
# Why this exists: three attempts to fix a flaky test failed because it passed
# locally and failed in CI, and the difference was never reproduced. "It works on
# my machine" is not a measurement. This makes the CI machine available.
#
# It is ALSO the thing to reach for before pushing a fix for a CI-only failure,
# which is the mistake that cost those three attempts.
#
# Deliberately NOT wired into `npm test` or the default loop: it is a debugging
# and verification tool, run by hand when CI and the local machine disagree.
#
#   docker build -f tools/ci/Dockerfile -t iu-ci .
#   docker run --rm -v "$PWD:/repo" -w /repo iu-ci npm test
#   docker run --rm -v "$PWD:/repo" -w /repo iu-ci npm run test:browser
#
# Node 24 matches `.nvmrc`, which the workflow reads; the base image is
# bookworm to match the runner's glibc. The version is read from `.nvmrc` at run
# time by `tools/ci/run-in-ci.sh`, so it cannot drift from the workflow.

# Ubuntu 24.04 is what `ubuntu-latest` currently maps to, and the glibc and the
# package versions matter for a Chromium launch.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# `curl` and `xz` for the Node tarball, `git` because npm inspects it, `unzip`
# for `make verify`, `make` because the `package` job runs `make release`, and
# Playwright's own dependencies for Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git unzip make ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Node from the official tarball, because the version is pinned in `.nvmrc` and
# Ubuntu's own package is a different one. `NODE_VERSION` is the exact version,
# resolved from `.nvmrc` by `run-in-ci.sh`; a bare major (v24.0) is not a release
# that exists.
ARG NODE_VERSION
RUN test -n "$NODE_VERSION" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version

# Chromium and the shared libraries it needs. `--with-deps` is the part that is
# easy to forget and produces a launch failure that reads like a code bug.
#
# NOT `PLAYWRIGHT_BROWSERS_PATH`: `findChrome` looks only in `$HOME/.cache/
# ms-playwright`, and it is right to, because that is where `playwright install`
# puts the browser for every user and every CI runner. Setting the path elsewhere
# made the whole tier SKIP and report green, which is the precise failure the
# workflow's own guard exists to catch.
#
# `chromium`, not the default: the bundled headless shell cannot load extensions,
# so it is deliberately not what the tests need.
ARG HOME=/root
RUN npm install -g playwright@latest \
    && npx playwright install --with-deps chromium \
    && test -d "$HOME/.cache/ms-playwright" \
    && ls "$HOME/.cache/ms-playwright" \
    && rm -rf /tmp/*

# The repo is mounted at run time, not copied, so the container always tests the
# working tree rather than a snapshot taken at build time.
WORKDIR /repo

# The mount is owned by the host user, so git refuses it as "dubious ownership"
# and `history.test.mjs` silently skips its nine checks and reports green. CI
# checks out as the runner user and never hits this, so the container has to be
# told the mount is trusted, or it tests something CI does not.
RUN git config --global --add safe.directory /repo
