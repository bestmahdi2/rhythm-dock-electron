# Rhythm Dock — build entry points
#
# Thin wrapper over the npm scripts, so there is one place that documents what
# each target actually needs. electron-builder cannot cross-compile the native
# dependency (better-sqlite3), so every OS target must be built on that OS or
# in the matching CI runner. See README.md for the details.
#
# Usage:  make            (build for the host platform)
#         make linux      (AppImage + deb + rpm + tar.gz)
#         make help

APP_DIR := .
NPM     := npm

.DEFAULT_GOAL := dist
.PHONY: help install rebuild icons start dist dist-current \
        win win64 win32 mac mac-x64 mac-arm64 \
        linux appimage deb rpm doctor clean distclean

## ---------------------------------------------------------------- setup ----

help: ## List the available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies and rebuild native modules for Electron
	$(NPM) install

rebuild: ## Rebuild native modules only (after an Electron version bump)
	$(NPM) run rebuild

icons: ## Regenerate the icon set from the source artwork
	$(NPM) run icons

start: ## Run the app in development mode
	$(NPM) start

## ------------------------------------------------------------- packaging ----

dist: dist-current ## Alias for dist-current

dist-current: ## Build for the host platform and architecture
	$(NPM) run dist:current

# --- Windows -----------------------------------------------------------------
# NSIS installer + portable exe. Buildable on Windows; also buildable from Linux
# with wine installed, though the native rebuild makes that unreliable.

win: ## Windows x64 + ia32 (NSIS installer and portable)
	$(NPM) run dist:win

win64: ## Windows x64 only
	$(NPM) run build:win64

win32: ## Windows ia32 only
	$(NPM) run build:win32

# --- macOS -------------------------------------------------------------------
# Must run on macOS: dmg creation uses hdiutil. Builds are unsigned, so
# Gatekeeper will quarantine them — see the README for the xattr workaround.

mac: ## macOS universal set (x64 + arm64 dmg and zip)
	$(NPM) run dist:mac

mac-x64: ## macOS Intel only
	$(NPM) run build:mac:x64

mac-arm64: ## macOS Apple Silicon only
	$(NPM) run build:mac:arm64

# --- Linux -------------------------------------------------------------------
# rpm requires the `rpm`/`rpmbuild` tooling on the build host even when building
# on Debian or Ubuntu. `make doctor` checks for it.

linux: ## Linux AppImage + deb + rpm + tar.gz
	$(NPM) run dist:linux

appimage: ## Linux AppImage only (runs on every distribution)
	$(NPM) run build:linux:appimage

deb: ## Debian / Ubuntu package
	$(NPM) run build:linux:deb

rpm: ## Fedora / RHEL package
	$(NPM) run build:linux:rpm

## -------------------------------------------------------------- utilities ----

doctor: ## Check that the host has what the Linux packaging targets need
	@echo "node    : $$(node --version 2>/dev/null || echo 'MISSING')"
	@echo "npm     : $$(npm --version 2>/dev/null || echo 'MISSING')"
	@echo "python3 : $$(python3 --version 2>/dev/null || echo 'MISSING — needed by node-gyp')"
	@echo "rpmbuild: $$(rpmbuild --version 2>/dev/null || echo 'MISSING — needed for: make rpm')"
	@echo "fakeroot: $$(fakeroot -v 2>/dev/null || echo 'MISSING — needed for: make deb')"

clean: ## Remove build output
	rm -rf dist

distclean: clean ## Remove build output and installed dependencies
	rm -rf node_modules
