#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="${CERT_DIR:-/Users/houhaixu/Personal/cert}"
P12_PATH="${P12_PATH:-$CERT_DIR/developer_id_application.p12}"
APP_PASSWORD_FILE="${APP_PASSWORD_FILE:-$CERT_DIR/app key.md}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: wenlin fei (UU94JSVAA9)}"
APPLE_ID="${APPLE_ID:-apple@stackcairn.io}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-UU94JSVAA9}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required. Install it and authenticate with: gh auth login" >&2
  exit 1
fi

if [ ! -f "$APP_PASSWORD_FILE" ]; then
  echo "missing Apple app-specific password file: $APP_PASSWORD_FILE" >&2
  exit 1
fi

if [ ! -f "$P12_PATH" ]; then
  if ! command -v security >/dev/null 2>&1; then
    echo "missing p12 file: $P12_PATH" >&2
    echo "security CLI is required to export it automatically from Keychain" >&2
    exit 1
  fi
  if [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
    APPLE_CERTIFICATE_PASSWORD="$(openssl rand -base64 32)"
  fi
  mkdir -p "$(dirname "$P12_PATH")"
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep -F -- "$APPLE_SIGNING_IDENTITY" >/dev/null || {
    echo "signing identity not found in keychain: $APPLE_SIGNING_IDENTITY" >&2
    exit 1
  }
  security export \
    -k "$KEYCHAIN_PATH" \
    -t identities \
    -f pkcs12 \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -o "$P12_PATH" >/dev/null
  chmod 600 "$P12_PATH"
  echo "Exported Developer ID identity to $P12_PATH"
elif [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  echo "APPLE_CERTIFICATE_PASSWORD is required for the existing exported .p12" >&2
  exit 1
fi

APPLE_APP_SPECIFIC_PASSWORD="$(tr -d '\n\r' < "$APP_PASSWORD_FILE")"
P12_BASE64="$(base64 < "$P12_PATH" | tr -d '\n')"

printf '%s' "$P12_BASE64" | gh secret set APPLE_CERTIFICATE_P12_BASE64
printf '%s' "$APPLE_CERTIFICATE_PASSWORD" | gh secret set APPLE_CERTIFICATE_PASSWORD
printf '%s' "$APPLE_SIGNING_IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID
printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID
printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD

if [ -n "${LIVEAGENT_GATEWAY_TOKEN:-}" ]; then
  printf '%s' "$LIVEAGENT_GATEWAY_TOKEN" | gh secret set LIVEAGENT_GATEWAY_TOKEN
fi

if [ -n "${RAILWAY_TOKEN:-}" ]; then
  printf '%s' "$RAILWAY_TOKEN" | gh secret set RAILWAY_TOKEN
fi

if [ -n "${RAILWAY_SERVICE:-}" ]; then
  printf '%s' "$RAILWAY_SERVICE" | gh variable set RAILWAY_SERVICE
fi

if [ -n "${RAILWAY_ENVIRONMENT:-}" ]; then
  printf '%s' "$RAILWAY_ENVIRONMENT" | gh variable set RAILWAY_ENVIRONMENT
fi

echo "GitHub release secrets updated."
