# PR Babysitting Agent — self-contained image.
#
# Bundles the whole runtime (Node 22, gh, git, yarn, Playwright Chromium) and
# the prebuilt dashboard. State + creds live in a bind-mounted data dir at
# /data (host ./.data — see docker-compose.yml / README): /data/.env,
# /data/config.json, and heavy churny state (db, repo clones, worktrees,
# ci-logs) directly under /data — no extra nesting.
FROM node:22-bookworm

# --- OS tooling the daemon shells out to --------------------------------------
#   git        clone / fast-forward push (worktrees.ts, gh.ts)
#   gh         all GitHub API + push operations (gh.ts)
#   yarn       target repos (e.g. adRise/www) install via `yarn --frozen-lockfile`
#   gosu       drop privileges to the host UID at runtime (entrypoint)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg git gosu \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && corepack enable \
  && rm -rf /var/lib/apt/lists/*

# --- app (immutable install tree) --------------------------------------------
WORKDIR /opt/babysit

# Install deps first for layer caching. Copy the manifests for every workspace.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

# Playwright Chromium + its system libraries (Excalidraw overview renderer).
# Install to a world-readable path so the daemon still finds it after the
# entrypoint optionally drops to a non-root PUID (see entrypoint.sh).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx playwright install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright

# Source + build (server dist + web dist).
COPY . .
RUN npm run build

# The daemon's state + creds are rooted here at runtime via env (see entrypoint).
ENV BABYSIT_DATA_DIR=/data \
    BABYSIT_ENV_FILE=/data/.env \
    BABYSIT_CONFIG=/data/config.json \
    BABYSIT_DISABLE_BANNERS=1 \
    BABYSIT_HOST=0.0.0.0

EXPOSE 4317

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run"]
