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

# WHICH BROWSER THIS BUILD IS FOR.
#
# `both` is the default and produces the single ZIP that serves both stores, unchanged
# from before this variable existed. `chrome` and `firefox` produce a package whose
# manifest declares only that browser's keys and permissions, which is what removes the
# three "invalid/ignored key" warnings `web-ext lint` reports against the shared one.
#
# The transform lives in `tools/make-manifest.mjs` and is generated from the single
# source `manifest.json`, never a second checked-in copy: two manifests would be two
# things to keep in step, which this repository has paid for twice already.
TARGET  ?= both

BUILD   := build
# Target-specific staging and artefact names, so a per-browser build cannot overwrite
# the shared one. `both` keeps the original names exactly, so nothing that reads them
# changes.
SUFFIX  := $(if $(filter-out both,$(TARGET)),-$(TARGET),)
STAGE   := $(BUILD)/stage$(SUFFIX)
ZIP     := $(BUILD)/$(SLUG)-$(VERSION)$(SUFFIX).zip

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
           LICENSE README.md THIRD-PARTY.md THIRD-PARTY-NOTES.md CHROMEWEBSTORE.md AMO-READINESS.md TESTING.md \
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

.PHONY: ui
ui: ## Side-panel preview at http://127.0.0.1:8099
	npm run ui

# --- Packaging ---------------------------------------------------------------

.PHONY: stage
stage: ## Copy the shipping set into build/stage (TARGET=both|chrome|firefox)
	@rm -rf $(STAGE)
	@mkdir -p $(STAGE)
	@for entry in $(SHIPPED); do \
		if [ ! -e "$$entry" ]; then echo "MISSING: $$entry" >&2; exit 1; fi; \
		cp -r "$$entry" $(STAGE)/; \
	done
	@# Per-browser manifest, generated from the single source. `both` copies it as-is,
	@# which is the original behaviour and why the default artifact is unchanged.
	@if [ "$(TARGET)" != "both" ]; then \
		node tools/make-manifest.mjs $(TARGET) $(STAGE)/manifest.json; \
	fi
	@# Directories that must never appear, asserted rather than assumed. This is
	@# the failure this whole target exists to prevent, and a silent regression
	@# would only be noticed by someone reading the artifact's file list.
	@for bad in node_modules docs test tools .git .agents .vscode; do \
		if [ -e "$(STAGE)/$$bad" ]; then echo "LEAKED INTO STAGE: $$bad" >&2; exit 1; fi; \
	done
	@echo "staged $$(find $(STAGE) -type f | wc -l) files -> $(STAGE) ($(TARGET))"

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
	@echo
	@echo "The source package AMO requires for the minified bundle:"
	@echo "  make source      -> $(SOURCE_ZIP)"
	@echo
	@echo "Per-browser packages, each declaring only that browser's keys:"
	@echo "  make release TARGET=chrome"
	@echo "  make release TARGET=firefox"

# --- The AMO source submission ------------------------------------------------
#
# A SECOND artifact, not the extension. Mozilla requires the original source and a
# rebuild instruction when a submitted file is minified, and `src/vendor/mediabunny.js`
# is. The reviewer's job is to run the build and diff the result against the file in
# the extension package, so this package holds everything that build reads and
# nothing that it does not.
#
# NOT `web-ext build` and NOT the `SHIPPED` list. The shipping list is the extension
# as a user receives it; this is the source as a reviewer receives it, and the two
# sets overlap only in the files that are both. `test/` and `docs/` are deliberately
# absent: they are the repository's, not the reviewer's, and a smaller package is a
# package that gets read.
SOURCE_DIR    := $(BUILD)/source
SOURCE_ROOT   := $(SOURCE_DIR)/iu-language-companion
SOURCE_ZIP    := $(BUILD)/$(SLUG)-$(VERSION)-source.zip

# What a reviewer needs to reproduce the generated file: the source it is built
# from, the script that builds it, the two files that pin the versions, and the
# documents that name the libraries and their licences.
#
# COPIED ONE BY ONE, each into its own directory, rather than looped over. The loop
# looked tidier and was wrong: `cp -r tools/build-vendor.mjs dest/` puts the script at
# the PACKAGE ROOT, not under `tools/`, so the reviewer's build command would not
# resolve and the README would end up in the wrong place. Preserving the path is the
# requirement, and saying where each file goes makes that visible.
.PHONY: verify-source
verify-source: ## Rebuild the generated bundle and assert it is byte-identical
	@node tools/verify-source.mjs

.PHONY: source
source: verify-source ## Build the source package for Mozilla review -> build/*-source.zip
	@rm -rf $(SOURCE_DIR)
	@mkdir -p $(SOURCE_ROOT)/tools
	@cp -r src $(SOURCE_ROOT)/src
	@cp tools/build-vendor.mjs $(SOURCE_ROOT)/tools/build-vendor.mjs
	@cp tools/amo/AMO-SOURCE.md $(SOURCE_ROOT)/README.md
	@cp package.json package-lock.json .nvmrc LICENSE THIRD-PARTY.md THIRD-PARTY-NOTES.md $(SOURCE_ROOT)/
	@# The manifest, so the package says WHICH version these sources build, which is
	@# what Mozilla means by "matching source code must be attached to every extension
	@# version". It is not read by the build; it identifies the build.
	@cp manifest.json $(SOURCE_ROOT)/manifest.json
	@# The reviewer README is at the package ROOT, not buried in tools/, or the first
	@# thing a reviewer sees is a directory to open before finding out how to build.
	@# Copied to that name rather than moved, so the repository copy stays the source.
	@for bad in node_modules docs test .git .cache; do \
		if [ -e "$(SOURCE_ROOT)/$$bad" ]; then echo "LEAKED INTO SOURCE: $$bad" >&2; exit 1; fi; \
	done
	@node tools/pack.mjs $(SOURCE_ROOT) $(SOURCE_ZIP) $(VERSION) --source >/dev/null
	@echo "source artifact: $(SOURCE_ZIP)"
	@echo "  $$(find $(SOURCE_ROOT) -type f | wc -l) files, $$(du -h $(SOURCE_ZIP) | cut -f1)"

.PHONY: verify-source-zip
verify-source-zip: source ## Assert the source package contains what a rebuild needs
	@node tools/verify-source-zip.mjs $(SOURCE_ZIP)
	@echo "verified: $(SOURCE_ZIP)"

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
	@echo "  build/            make release"
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
