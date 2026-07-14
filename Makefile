# Makefile for the PR Babysitting Agent
#
# Native + launchd is the recommended run path on macOS: `npm run dev:server`
# under a launchd agent (RunAtLoad + KeepAlive), reading/writing state directly
# on the host disk (no VirtioFS I/O tax, real macOS escalation banners). A
# self-contained Docker image is kept as an alternative (docker-* targets).

SHELL := /bin/bash

# Dashboard + API port (kept in sync with config.json and docker-compose.yml).
SERVER_PORT := 4317

# launchd (installed daemon) — see launchd/io.tubi.babysit-agent.plist
LAUNCHD_LABEL  := io.tubi.babysit-agent
LAUNCHD_PLIST  := launchd/$(LAUNCHD_LABEL).plist
LAUNCHD_DEST   := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_DOMAIN := gui/$(shell id -u)
# Daemon logs live alongside state under the workspace .data/ (see the plist).
DAEMON_OUT_LOG := $(CURDIR)/.data/daemon.out.log
DAEMON_ERR_LOG := $(CURDIR)/.data/daemon.err.log

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@echo "PR Babysitting Agent"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install all workspace dependencies
	npm install

.PHONY: build
build: ## Build backend + frontend for production
	npm run build

.PHONY: setup-render
setup-render: ## Install Chromium for the Excalidraw diagram renderer (one-time)
	npx playwright install chromium
	@echo "Chromium installed for Playwright — PR-overview diagram rendering is ready."

# ---------------------------------------------------------------------------
# Docker (self-contained image; ./.data is bind-mounted to /data)
# ---------------------------------------------------------------------------

DOCKER_IMAGE := babysit-agent:latest
# Own files written into ./.data as the invoking host user.
PUID := $(shell id -u)
PGID := $(shell id -g)

.PHONY: docker-build
docker-build: ## Build the self-contained agent image
	docker build -t $(DOCKER_IMAGE) .

.PHONY: docker-setup
docker-setup: ## Run the interactive setup wizard (writes ./.data/.env + ./.data/config.json)
	mkdir -p "$(CURDIR)/.data"
	docker run -it --rm -v "$(CURDIR)/.data":/data -e PUID=$(PUID) -e PGID=$(PGID) $(DOCKER_IMAGE) setup

.PHONY: docker-doctor
docker-doctor: ## Validate creds + config non-interactively
	docker run --rm -v "$(CURDIR)/.data":/data -e PUID=$(PUID) -e PGID=$(PGID) $(DOCKER_IMAGE) doctor

.PHONY: docker-recover
docker-recover: ## Probe base clones for corruption; print recovery commands (deletes nothing)
	docker run --rm -v "$(CURDIR)/.data":/data -e PUID=$(PUID) -e PGID=$(PGID) $(DOCKER_IMAGE) recover

.PHONY: docker-reset-cache
docker-reset-cache: ## Stop daemon, wipe .data/cache (worktrees + ci-logs), restart — repos/creds untouched
	docker compose down
	rm -rf "$(CURDIR)/.data/cache"
	PUID=$(PUID) PGID=$(PGID) docker compose up -d
	@echo "Cache cleared; daemon restarted. Base clones + creds untouched."

.PHONY: docker-up
docker-up: ## Start the daemon in the background (docker compose)
	PUID=$(PUID) PGID=$(PGID) docker compose up -d
	@echo "Dashboard: http://localhost:$(SERVER_PORT)"

.PHONY: docker-down
docker-down: ## Stop the daemon
	docker compose down

.PHONY: docker-restart
docker-restart: ## Recreate the daemon (picks up image/config changes)
	PUID=$(PUID) PGID=$(PGID) docker compose up -d --force-recreate
	@echo "Daemon restarted. Dashboard: http://localhost:$(SERVER_PORT)"

.PHONY: docker-logs
docker-logs: ## Tail the daemon logs
	docker compose logs -f

# ---------------------------------------------------------------------------
# launchd (native daemon — runs `npm run dev:server` at login, KeepAlive)
# ---------------------------------------------------------------------------

.PHONY: daemon-install
daemon-install: ## Install & load the launchd agent (symlink plist, bootstrap)
	@ln -sf "$(CURDIR)/$(LAUNCHD_PLIST)" "$(LAUNCHD_DEST)"
	@launchctl bootstrap "$(LAUNCHD_DOMAIN)" "$(LAUNCHD_DEST)" 2>/dev/null || \
		launchctl load "$(LAUNCHD_DEST)"
	@echo "daemon installed and loaded ($(LAUNCHD_LABEL)). Dashboard: http://localhost:$(SERVER_PORT)"

.PHONY: daemon-uninstall
daemon-uninstall: ## Unload & remove the launchd agent
	@launchctl bootout "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)" 2>/dev/null || \
		launchctl unload "$(LAUNCHD_DEST)" 2>/dev/null || true
	@rm -f "$(LAUNCHD_DEST)"
	@echo "daemon uninstalled ($(LAUNCHD_LABEL))"

.PHONY: daemon-restart
daemon-restart: ## Restart the launchd daemon (picks up config.json changes)
	@launchctl kickstart -k "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)"
	@echo "daemon restarted ($(LAUNCHD_LABEL))"

.PHONY: daemon-stop
daemon-stop: ## Stop the launchd daemon (until next login/kickstart)
	@launchctl kill SIGTERM "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)" 2>/dev/null || true
	@echo "daemon stop signal sent ($(LAUNCHD_LABEL))"

.PHONY: daemon-status
daemon-status: ## Show launchd daemon status (PID / last exit code)
	@launchctl list | grep -E "PID|$(LAUNCHD_LABEL)" || echo "$(LAUNCHD_LABEL): not loaded"

.PHONY: daemon-logs
daemon-logs: ## Tail the launchd daemon's stdout + stderr logs
	@touch "$(DAEMON_OUT_LOG)" "$(DAEMON_ERR_LOG)"
	@tail -n 50 -f "$(DAEMON_OUT_LOG)" "$(DAEMON_ERR_LOG)"
