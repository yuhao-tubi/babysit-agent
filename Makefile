# Makefile for the PR Babysitting Agent
#
# Docker is the run path: a self-contained image (Node 22, gh, git, yarn,
# Playwright Chromium + the prebuilt dashboard) that persists all state under
# the bind-mounted ./.data. Boot persistence is handled by the compose
# `restart: unless-stopped` policy (+ Docker Desktop starting at login) — no
# launchd/PID-file service management needed.

SHELL := /bin/bash

# Dashboard + API port (kept in sync with config.json and docker-compose.yml).
SERVER_PORT := 4317

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
