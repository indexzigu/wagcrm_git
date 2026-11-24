#!/usr/bin/env bash
set -euo pipefail
# Crontab entry point for expansion-merge.mjs (owner-click-approved merge + deploy of expansion-bot PRs).
# cron gives a minimal PATH; node/gh/git live under Homebrew/usr/local on this host.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec node "$(cd "$(dirname "$0")" && pwd)/expansion-merge.mjs" "$@"
