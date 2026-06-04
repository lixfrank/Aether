#!/usr/bin/env bash
# ~/.aether/health/cache_check.sh
# Seeded from .aether/health/ via seedDefaultAssets() at CLI startup.
# Usage: bash ~/.aether/health/cache_check.sh
# Exit 0 = cache valid, Exit 1 = cache expired or missing

CACHE_FILE="$HOME/.aether/health/global_health.json"
MAX_AGE_SECONDS=86400  # 24 hours

if [ ! -f "$CACHE_FILE" ]; then exit 1; fi

now=$(date +%s)
mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null)
age=$((now - mtime))

if [ "$age" -gt "$MAX_AGE_SECONDS" ]; then exit 1; fi
exit 0
