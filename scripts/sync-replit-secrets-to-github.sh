#!/usr/bin/env bash
set -euo pipefail

# Sync non-empty key/value pairs from .replit to GitHub Actions repository secrets.
# Usage:
#   OWNER=creaotrhubn26 REPO=cutAI ./scripts/sync-replit-secrets-to-github.sh

OWNER="${OWNER:-creaotrhubn26}"
REPO="${REPO:-cutAI}"
SOURCE_FILE="${SOURCE_FILE:-.replit}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is not installed." >&2
  echo "Install from: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "Error: gh is not authenticated." >&2
  echo "Run: gh auth login" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Error: source file not found: $SOURCE_FILE" >&2
  exit 1
fi

uploaded=0
skipped=0
in_userenv_shared=0

while IFS= read -r line; do
  # Enter/exit the .replit user secret section.
  if [[ "$line" =~ ^[[:space:]]*\[userenv\.shared\][[:space:]]*$ ]]; then
    in_userenv_shared=1
    continue
  fi
  if [[ "$line" =~ ^[[:space:]]*\[[^\]]+\][[:space:]]*$ ]]; then
    in_userenv_shared=0
  fi
  [[ "$in_userenv_shared" -eq 1 ]] || continue

  # Skip comments and blank lines
  [[ -z "${line// }" ]] && continue
  [[ "$line" =~ ^[[:space:]]*# ]] && continue

  # Match KEY = "VALUE" or KEY="VALUE"
  if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*$ ]]; then
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"

    # Never upload empty values
    if [[ -z "$value" ]]; then
      skipped=$((skipped + 1))
      continue
    fi

    # Upload secret without printing value
    gh secret set "$key" --repo "$OWNER/$REPO" --body "$value" >/dev/null
    uploaded=$((uploaded + 1))
  fi
done < "$SOURCE_FILE"

echo "Done. Uploaded $uploaded secrets, skipped $skipped empty entries."
