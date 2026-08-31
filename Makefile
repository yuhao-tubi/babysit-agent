# Makefile for the PR Babysitting Agent
#
# Native + launchd is the recommended run path on macOS: the BUILT daemon
# (packages/server/dist/index.js) run directly under a launchd agent (RunAtLoad
# + KeepAlive), reading/writing state directly on the host disk (no VirtioFS I/O
# tax, real macOS escalation banners). A self-contained Docker image is kept as
# an alternative (docker-* targets).
#
# The daemon is run directly rather than through `npm run dev:server` (tsx watch)
# because the watcher outlives its child: a crashed daemon left the watcher alive,
# so launchd's KeepAlive never fired and the outage was invisible to
# `launchctl list`. `make restart` rebuilds, so the edit→restart loop is intact.

SHELL := /bin/bash

# Dashboard + API port (kept in sync with config.json and docker-compose.yml).
SERVER_PORT := 4317

# launchd (installed daemon). The committed file is a TEMPLATE with placeholders
# (__WORKDIR__, __NODE_BIN__, …); `make start` renders it into ~/Library/
# LaunchAgents so no host-specific path is ever committed.
LAUNCHD_LABEL    := local.babysit-agent
LAUNCHD_TEMPLATE := launchd/babysit-agent.plist.template
LAUNCHD_DEST     := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_DOMAIN   := gui/$(shell id -u)
# Resolve the node/npm that will run the daemon from the CURRENT shell (nvm-safe).
LAUNCHD_NODE     := $(shell command -v node)
LAUNCHD_NPM_CLI  := $(shell node -e 'console.log(require("path").join(process.execPath,"..","..","lib","node_modules","npm","bin","npm-cli.js"))' 2>/dev/null)
LAUNCHD_NODE_DIR := $(patsubst %/,%,$(dir $(LAUNCHD_NODE)))
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

.PHONY: deps
deps: ## Install all workspace dependencies
	npm install

.PHONY: build
build: ## Build backend + frontend for production
	npm run build

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

.PHONY: setup
setup: ## Interactive native setup wizard (prompts + validates creds, writes ./.env + ./config.json)
	npx tsx packages/server/src/setup.ts setup

.PHONY: doctor
doctor: ## Validate the existing ./.env + ./config.json creds non-interactively
	npx tsx packages/server/src/setup.ts doctor

.PHONY: recover
recover: ## Probe base clones for corruption; print recovery commands (deletes nothing)
	npx tsx packages/server/src/setup.ts recover

.PHONY: dev
dev: ## Run the daemon in the foreground (tsx watch; Ctrl-C to stop)
	npm run dev:server

.PHONY: start
start: build ## Install & load the launchd agent (render plist from template, bootstrap)
	@test -x "$(LAUNCHD_NODE)" || { echo "no node on PATH — cannot render the plist"; exit 1; }
	@mkdir -p "$(HOME)/Library/LaunchAgents"
	@sed -e 's|__LABEL__|$(LAUNCHD_LABEL)|g' \
	     -e 's|__NODE_BIN__|$(LAUNCHD_NODE)|g' \
	     -e 's|__WORKDIR__|$(CURDIR)|g' \
	     -e 's|__HOME__|$(HOME)|g' \
	     -e 's|__PATH__|$(LAUNCHD_NODE_DIR):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin|g' \
	     "$(CURDIR)/$(LAUNCHD_TEMPLATE)" > "$(LAUNCHD_DEST)"
	@launchctl bootstrap "$(LAUNCHD_DOMAIN)" "$(LAUNCHD_DEST)" 2>/dev/null || \
		launchctl load "$(LAUNCHD_DEST)"
	@echo "daemon installed and loaded ($(LAUNCHD_LABEL)). Dashboard: http://localhost:$(SERVER_PORT)"

.PHONY: uninstall
uninstall: ## Unload & remove the launchd agent
	@launchctl bootout "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)" 2>/dev/null || \
		launchctl unload "$(LAUNCHD_DEST)" 2>/dev/null || true
	@rm -f "$(LAUNCHD_DEST)"
	@echo "daemon uninstalled ($(LAUNCHD_LABEL))"

.PHONY: restart
restart: build ## Rebuild + restart the launchd agent (picks up source & config.json changes)
	@launchctl kickstart -k "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)"
	@echo "daemon restarted ($(LAUNCHD_LABEL))"

.PHONY: restart-only
restart-only: ## Restart WITHOUT rebuilding (config.json-only changes)
	@launchctl kickstart -k "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)"
	@echo "daemon restarted, no rebuild ($(LAUNCHD_LABEL))"

.PHONY: stop
stop: ## Stop the launchd agent (until next login/kickstart)
	@launchctl kill SIGTERM "$(LAUNCHD_DOMAIN)/$(LAUNCHD_LABEL)" 2>/dev/null || true
	@echo "daemon stop signal sent ($(LAUNCHD_LABEL))"

.PHONY: status
status: ## Show launchd agent status (PID / last exit code)
	@launchctl list | grep -E "PID|$(LAUNCHD_LABEL)" || echo "$(LAUNCHD_LABEL): not loaded"

.PHONY: logs
logs: ## Tail the launchd agent's stdout + stderr logs
	@touch "$(DAEMON_OUT_LOG)" "$(DAEMON_ERR_LOG)"
	@tail -n 50 -f "$(DAEMON_OUT_LOG)" "$(DAEMON_ERR_LOG)"
