# Local "CI": the whole validate (lint → typecheck → tests → E2E on the real Electron app → 100%
# coverage gate) inside a clean Linux, the way a CI server would run it. No GitHub Actions: this
# runs on the developer's PC before a commit is pushed (npm run ci:docker).
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# Electron's runtime libraries, a virtual display for the E2E, git for the scripts that read the repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus git ca-certificates \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 libxkbcommon0 \
      libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
      libpango-1.0-0 libcairo2 libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# Root in a container cannot use Chromium's sandbox; only this CI image turns it off.
ENV ELECTRON_DISABLE_SANDBOX=1
WORKDIR /work
