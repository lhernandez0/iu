# IU — build and release tasks.
#
# `npm test` is the primary entry point and this does not replace it. What lives
# here is the PACKAGING work: producing the file that goes to the two stores, and
# the checks that have to pass before it does.
#
# WHY A MAKEFILE AND NOT MORE npm SCRIPTS. The packaging steps are a dependency
# graph — you cannot lint before staging, and you cannot build before linting —
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

# WHAT SHIPS. Everything else in the repository is development material.
#
# This list is the single source of truth. It used to live in three places — the
# store doc as prose, a shell pipeline in someone's history, and a note in the
# README — which is how a `dist/` directory ends up shipping because nobody
# remembered to exclude it.
#
# `web-ext build` is NOT used to assemble this. Its defaults exclude
# `node_modules/` and dotfiles but happily include `docs/`, `test/` and `tools/` —
# measured, not assumed: building the repository root as-is put 88 development
# files in the package. It is used below to LINT and to ZIP a directory that has
# already been filtered.
SHIPPED := manifest.json icons src \
           LICENSE README.md THIRD-PARTY.md CHROMEWEBSTORE.md TESTING.md \
           package.json .env.example

# --- Help --------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@echo "IU $(VERSION) — $(NAME)"
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

.PHONY: ui
ui: ## Side-panel preview at http://127.0.0.1:8099
	npm run ui

# --- Packaging ---------------------------------------------------------------

.PHONY: stage
stage: ## Copy the shipping set into build/stage
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)
	@for entry in $(SHIPPED); do \
		if [ ! -e "$$entry" ]; then echo "MISSING: $$entry" >&2; exit 1; fi; \
		cp -r "$$entry" $(STAGE)/; \
	done
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
