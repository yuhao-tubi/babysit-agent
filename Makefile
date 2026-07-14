# Makefile for the PR Babysitting Agent
#
# Composes startup/shutdown of the two services:
#   backend  -> @babysit/server  (Fastify daemon + API + SSE, port 4317)
#   frontend -> @babysit/web     (Vite + React dashboard, dev port 4318)
#
# Background services are tracked via PID files under .run/ and logs under logs/.

SHELL := /bin/bash

# Ports (kept in sync with config.json and packages/web/vite.config.ts)
SERVER_PORT := 4317
WEB_PORT    := 4318

RUN_DIR  := .run
LOG_DIR  := .run/logs

# launchd (installed daemon) — see launchd/io.tubi.babysit-agent.plist
LAUNCHD_LABEL := io.tubi.babysit-agent
LAUNCHD_PLIST := launchd/$(LAUNCHD_LABEL).plist
LAUNCHD_DEST  := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_DOMAIN := gui/$(shell id -u)
DAEMON_OUT_LOG := $(HOME)/.babysit-agent/daemon.out.log
DAEMON_ERR_LOG := $(HOME)/.babysit-agent/daemon.err.log

SERVER_PID := $(RUN_DIR)/server.pid
WEB_PID    := $(RUN_DIR)/web.pid
SERVER_LOG := $(LOG_DIR)/server.log
WEB_LOG    := $(LOG_DIR)/web.log

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@echo "PR Babysitting Agent — service composition"
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

$(RUN_DIR) $(LOG_DIR):
	@mkdir -p $@

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

.PHONY: up
up: start-server start-web ## Start backend + frontend (dev mode, background)
	@echo "All services up. Dashboard: http://localhost:$(WEB_PORT)  API: http://localhost:$(SERVER_PORT)"

.PHONY: start-server
start-server: | $(RUN_DIR) $(LOG_DIR) ## Start the backend daemon (background)
	@if [ -f "$(SERVER_PID)" ] && kill -0 "$$(cat $(SERVER_PID))" 2>/dev/null; then \
		echo "server already running (pid $$(cat $(SERVER_PID)))"; \
	else \
		npm run dev:server > "$(SERVER_LOG)" 2>&1 & echo $$! > "$(SERVER_PID)"; \
		echo "server started (pid $$(cat $(SERVER_PID))) -> $(SERVER_LOG)"; \
	fi

.PHONY: start-web
start-web: | $(RUN_DIR) $(LOG_DIR) ## Start the frontend dev server (background)
	@if [ -f "$(WEB_PID)" ] && kill -0 "$$(cat $(WEB_PID))" 2>/dev/null; then \
		echo "web already running (pid $$(cat $(WEB_PID)))"; \
	else \
		npm run dev:web > "$(WEB_LOG)" 2>&1 & echo $$! > "$(WEB_PID)"; \
		echo "web started (pid $$(cat $(WEB_PID))) -> $(WEB_LOG)"; \
	fi

.PHONY: prod
prod: build ## Build then run the production server (foreground; serves built dashboard at :4317)
	npm start

# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

.PHONY: down
down: stop-web stop-server ## Stop frontend + backend
	@echo "All services stopped."

.PHONY: stop-server
stop-server: ## Stop the backend daemon
	@$(call stop_pid,$(SERVER_PID),server)

.PHONY: stop-web
stop-web: ## Stop the frontend dev server
	@$(call stop_pid,$(WEB_PID),web)

.PHONY: restart
restart: down up ## Restart backend + frontend

# ---------------------------------------------------------------------------
# Status / logs
# ---------------------------------------------------------------------------

.PHONY: status
status: ## Show running status of both services
	@$(call status_pid,$(SERVER_PID),server,$(SERVER_PORT))
	@$(call status_pid,$(WEB_PID),web,$(WEB_PORT))

.PHONY: logs
logs: ## Tail logs from both services
	@touch "$(SERVER_LOG)" "$(WEB_LOG)"
	@tail -n 50 -f "$(SERVER_LOG)" "$(WEB_LOG)"

.PHONY: clean
clean: down ## Stop services and remove runtime/build artifacts
	@rm -rf $(RUN_DIR) $(LOG_DIR)
	@echo "Removed $(RUN_DIR)/ and $(LOG_DIR)/"

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

.PHONY: docker-up
docker-up: ## Start the daemon in the background (docker compose)
	PUID=$(PUID) PGID=$(PGID) docker compose up -d
	@echo "Dashboard: http://localhost:$(SERVER_PORT)"

.PHONY: docker-down
docker-down: ## Stop the daemon
	docker compose down

.PHONY: docker-logs
docker-logs: ## Tail the daemon logs
	docker compose logs -f

# ---------------------------------------------------------------------------
# launchd (installed daemon — runs `npm run dev:server` at login, KeepAlive)
# ---------------------------------------------------------------------------

.PHONY: daemon-install
daemon-install: ## Install & load the launchd agent (symlink plist, bootstrap)
	@ln -sf "$(CURDIR)/$(LAUNCHD_PLIST)" "$(LAUNCHD_DEST)"
	@launchctl bootstrap "$(LAUNCHD_DOMAIN)" "$(LAUNCHD_DEST)" 2>/dev/null || \
		launchctl load "$(LAUNCHD_DEST)"
	@echo "daemon installed and loaded ($(LAUNCHD_LABEL))"

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

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# stop_pid(pidfile, name): terminate a tracked process group gracefully, then hard.
define stop_pid
	if [ -f "$(1)" ] && kill -0 "$$(cat $(1))" 2>/dev/null; then \
		pid="$$(cat $(1))"; \
		kill "$$pid" 2>/dev/null || true; \
		for i in $$(seq 1 10); do kill -0 "$$pid" 2>/dev/null || break; sleep 0.3; done; \
		kill -9 "$$pid" 2>/dev/null || true; \
		rm -f "$(1)"; \
		echo "$(2) stopped (was pid $$pid)"; \
	else \
		rm -f "$(1)"; \
		echo "$(2) not running"; \
	fi
endef

# status_pid(pidfile, name, port)
define status_pid
	if [ -f "$(1)" ] && kill -0 "$$(cat $(1))" 2>/dev/null; then \
		echo "$(2): running (pid $$(cat $(1)), port $(3))"; \
	else \
		echo "$(2): stopped"; \
	fi
endef
