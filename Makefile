# IU, build and release tasks.
#
# `npm test` is the primary entry point and this does not replace it. What lives
# here is the PACKAGING work: producing the file that goes to the two stores, and
# the checks that have to pass before it does.
#
# WHY A MAKEFILE AND NOT MORE npm SCRIPTS. The packaging steps are a dependency
# graph, you cannot lint before staging, and you cannot build before linting,
# and npm scripts express that as `&&` chains in one line, which is unreadable and
# cannot be run partially. `make stage` and `make lint` are independently useful
# while working a problem out.
#
# The artifact is a single ZIP that serves BOTH stores: the manifest carries each
# browser's keys and each ignores the other's, so there is nothing to build
# differently for Chrome and Firefox.
#
# Every recipe here is offline. The only network step in the project is the
# capture tool, which is not wired into this file on purpose.

# --- Configuration -----------------------------------------------------------

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Read from the manifest, never duplicated. The artifact filename, the staging
# directory and the store submissions all have to agree with the manifest, and
# three copies of a version string is three chances to disagree.
NAME    := $(shell node -p "require('./manifest.json').name")
VERSION := $(shell node -p "require('./manifest.json').version")

# Slug for the filename: "IU Language Companion" -> "iu-language-companion".
SLUG    := $(shell echo "$(NAME)" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

BUILD   := build
STAGE   := $(BUILD)/stage
ZIP     := $(BUILD)/$(SLUG)-$(VERSION).zip

# The media decoder, built by `npm run vendor:libav` and NOT committed. It is a
# compiled FFmpeg variant that ships inside the extension, so it is built directly
# into `src/vendor/` (gitignored by name) rather than into `build/`, which means
# `SHIPPED` needs no special case: the normal `cp -r src` picks it up. This
# variable exists so `stage` can assert it was built.
DECODER := src/vendor/libav.js

# WHAT SHIPS. Everything else in the repository is development material.
#
# This list is the single source of truth. It used to live in three places, the
# store doc as prose, a shell pipeline in someone's history, and a note in the
# README, which is how a `dist/` directory ends up shipping because nobody
# remembered to exclude it.
#
# `web-ext build` is NOT used to assemble this. Its defaults exclude
# `node_modules/` and dotfiles but happily include `docs/`, `test/` and `tools/`,
# measured, not assumed: building the repository root as-is put 88 development
# files in the package. It is used below to LINT and to ZIP a directory that has
# already been filtered.
SHIPPED := manifest.json icons src \
           LICENSE README.md THIRD-PARTY.md CHROMEWEBSTORE.md TESTING.md \
           AI-USE.md AGENTS.md \
           package.json

# --- Help --------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@echo "IU $(VERSION), $(NAME)"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Artifact: $(ZIP)"

# --- Development -------------------------------------------------------------

.PHONY: test
test: ## Run the hermetic suites (no browser, no network)
	npm test

.PHONY: test-browser
test-browser: ## Run the browser tier (real Chromium, fixture pages)
	npm run test:browser

.PHONY: decoder
decoder: ## Build the media decoder into build/libav (needs emcc)
	npm run vendor:libav

.PHONY: ui
ui: ## Side-panel preview at http://127.0.0.1:8099
	npm run ui

# --- Packaging ---------------------------------------------------------------

.PHONY: stage
stage: ## Copy the shipping set into build/stage
	@# The media decoder is a build product, not committed. A release built without
	@# it would ship an extension that silently cannot play Dolby audio or HEVC, so
	@# its absence is a hard failure here rather than a puzzle for whoever installs
	@# the ZIP. It lives in `src/vendor/` (gitignored), so the loop below copies it
	@# along with the rest of `src/`; this only has to refuse to proceed without it.
	@if [ ! -f $(DECODER) ]; then \
		echo "MISSING: $(DECODER)" >&2; \
		echo "  the media decoder is not built. run: npm run vendor:libav (needs emcc)" >&2; \
		exit 1; \
	fi
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)
	@for entry in $(SHIPPED); do \
		if [ ! -e "$$entry" ]; then echo "MISSING: $$entry" >&2; exit 1; fi; \
		cp -r "$$entry" $(STAGE)/; \
	done
	@echo "staged the media decoder: $$(ls src/vendor/libav* | xargs -n1 basename | tr '\n' ' ')"
	@# Directories that must never appear, asserted rather than assumed. This is
	@# the failure this whole target exists to prevent, and a silent regression
	@# would only be noticed by someone reading the artifact's file list.
	@for bad in node_modules docs test tools .git .agents .vscode; do \
		if [ -e "$(STAGE)/$$bad" ]; then echo "LEAKED INTO STAGE: $$bad" >&2; exit 1; fi; \
	done
	@echo "staged $$(find $(STAGE) -type f | wc -l) files -> $(STAGE)"

.PHONY: lint
lint: stage ## Validate the staged extension the way both stores will
	@npx --yes web-ext lint --source-dir $(STAGE) --output json \
		| node tools/check-lint.mjs

.PHONY: pack
pack: lint ## Build the store ZIP from the staged set
	@mkdir -p $(BUILD)
	@rm -f $(ZIP)
	@node tools/pack.mjs $(STAGE) $(ZIP) $(VERSION)
	@echo "artifact: $(ZIP)"

.PHONY: verify
verify: pack ## Assert the artifact contains exactly what should ship
	@node tools/verify-zip.mjs $(ZIP)
	@echo "verified: $(ZIP)"

.PHONY: release
release: verify ## The full pre-submission check
	@echo
	@echo "Ready to upload:"
	@echo "  $(ZIP)"
	@echo "  $$(du -h $(ZIP) | cut -f1)"
	@echo
	@echo "Chrome Web Store -> upload the ZIP as-is."
	@echo "Firefox (AMO)    -> upload the same ZIP; it is a valid .xpi."

.PHONY: clean-stage
clean-stage:
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)

.PHONY: clean
clean: ## Remove everything under build/
	@rm -rf $(BUILD)
	@echo "cleaned $(BUILD)/"

# The regenerable caches, and how to get each one back. Every entry is a build
# product, a download, or a render: none of it is tracked in git, and none of it
# is needed to read or edit the source. The point of listing them together is
# that "the folder is 800 MB" is almost always these, and a cleanup done by hand
# from memory is how a tracked file gets deleted by mistake.
#
# `node_modules/` is deliberately NOT here. It is the one cache where the
# restore command is slow and needs the network, so removing it is a decision
# rather than a cleanup; `rm -rf node_modules` and `npm install` do it by hand.
.PHONY: clean-all
clean-all: clean ## Also remove the downloaded and rendered caches
	@# Only the DOWNLOADED files, by extension. The runner `test/conformance/run.mjs`
	@# is tracked source and lives in the same directory, so removing the directory
	@# would delete it. This is exactly the mistake the note above warns about.
	@rm -f test/conformance/*.mkv
	@rm -rf tools/ui/assets
	@rm -rf .cache
	@echo
	@echo "Removed, and how to restore each:"
	@echo "  build/            make release      (or npm run vendor:libav)"
	@echo "  conformance mkv   npm run conformance:fetch"
	@echo "  tools/ui/assets   re-render them, they are review screenshots"
	@echo "  .cache            npm run wordlists:fetch"
	@echo
	@echo "node_modules/ was kept: rm -rf node_modules && npm install to drop it."

.PHONY: size
size: ## Report what is using the space, largest first
	@du -sh . 2>/dev/null
	@echo
	@du -sh */ .[a-z]*/ 2>/dev/null | sort -rh | head -12
	@echo
	@echo "Regenerable caches: make clean-all"
