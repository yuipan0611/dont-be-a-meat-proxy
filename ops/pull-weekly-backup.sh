#!/usr/bin/env bash
# ops/pull-weekly-backup.sh — Weekly pull script running on 維護者's Mac.
# Pulls the latest Hub backup from VPS via SSH and encrypts it locally with age or gpg.
# Architecture: PULL model (Mac pulls from VPS; VPS never has Mac SSH keys or encryption private keys).

set -euo pipefail

# Default configuration
VPS_HOST="${VPS_HOST:vps.example.invalid}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-/var/backups/neighbor-hub}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-$HOME/Backups/neighbor-hub}"
ENCRYPTION_TOOL="${ENCRYPTION_TOOL:-auto}" # auto | age | gpg
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
AGE_RECIPIENT_FILE="${AGE_RECIPIENT_FILE:-}"
GPG_RECIPIENT="${GPG_RECIPIENT:-}"
KEEP_WEEKS="${KEEP_WEEKS:-12}"
MOCK_REMOTE_ARCHIVE="${MOCK_REMOTE_ARCHIVE:-}"
DRY_RUN=0
QUIET=0

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --host <hostname/ip>     VPS hostname or IP (default: vps.example.invalid)
  --user <user>            SSH user (default: root)
  --port <port>            SSH port (default: 22)
  --remote-dir <path>      Remote backup directory on VPS (default: /var/backups/neighbor-hub)
  --local-dir <path>       Local backup directory on Mac (default: ~/Backups/neighbor-hub)
  --tool <age|gpg>         Encryption tool to use (default: auto-detect)
  --age-recipient <pubkey> Age public key (e.g., age1...)
  --age-recipient-file <f> File containing age public key(s)
  --gpg-recipient <id>     GPG recipient email or key ID
  --keep-weeks <num>       Number of weekly backups to keep locally (default: 12)
  --mock-remote-archive <f> Use a local file as remote archive (TESTING ONLY)
  --dry-run                Check connection and simulate without downloading
  --quiet                  Suppress non-error output
  -h, --help               Show this help message

Environment variables:
  VPS_HOST, VPS_USER, VPS_PORT, REMOTE_BACKUP_DIR, LOCAL_BACKUP_DIR,
  ENCRYPTION_TOOL, AGE_RECIPIENT, AGE_RECIPIENT_FILE, GPG_RECIPIENT, KEEP_WEEKS
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) VPS_HOST="$2"; shift 2 ;;
    --user) VPS_USER="$2"; shift 2 ;;
    --port) VPS_PORT="$2"; shift 2 ;;
    --remote-dir) REMOTE_BACKUP_DIR="$2"; shift 2 ;;
    --local-dir) LOCAL_BACKUP_DIR="$2"; shift 2 ;;
    --tool) ENCRYPTION_TOOL="$2"; shift 2 ;;
    --age-recipient) AGE_RECIPIENT="$2"; shift 2 ;;
    --age-recipient-file) AGE_RECIPIENT_FILE="$2"; shift 2 ;;
    --gpg-recipient) GPG_RECIPIENT="$2"; shift 2 ;;
    --keep-weeks) KEEP_WEEKS="$2"; shift 2 ;;
    --mock-remote-archive) MOCK_REMOTE_ARCHIVE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

log() {
  if [[ "$QUIET" -eq 0 ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"
  fi
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "ERROR: Neither shasum nor sha256sum available." >&2
    exit 1
  fi
}

# Determine encryption tool
if [[ "$ENCRYPTION_TOOL" == "auto" ]]; then
  if command -v age >/dev/null 2>&1; then
    ENCRYPTION_TOOL="age"
  elif command -v gpg >/dev/null 2>&1; then
    ENCRYPTION_TOOL="gpg"
  else
    echo "ERROR: Neither 'age' nor 'gpg' is installed on this Mac." >&2
    echo "Please install one of them (e.g. brew install age or brew install gnupg)." >&2
    exit 1
  fi
fi

if [[ "$ENCRYPTION_TOOL" == "age" ]] && ! command -v age >/dev/null 2>&1; then
  echo "ERROR: 'age' is not found in PATH." >&2
  exit 1
fi

if [[ "$ENCRYPTION_TOOL" == "gpg" ]] && ! command -v gpg >/dev/null 2>&1; then
  echo "ERROR: 'gpg' is not found in PATH." >&2
  exit 1
fi

log "Encryption tool selected: $ENCRYPTION_TOOL"
log "Target VPS: ${VPS_USER}@${VPS_HOST}:${VPS_PORT}"
log "Local backup destination: $LOCAL_BACKUP_DIR"

# Test SSH connection & find latest backup
log "Querying latest remote backup on VPS..."
if [[ -n "$MOCK_REMOTE_ARCHIVE" ]]; then
  log "Using mock remote archive: $MOCK_REMOTE_ARCHIVE"
  LATEST_REMOTE_ARCHIVE="$MOCK_REMOTE_ARCHIVE"
else
  SSH_CMD="ssh -p $VPS_PORT -o BatchMode=yes -o ConnectTimeout=10 ${VPS_USER}@${VPS_HOST}"
  LATEST_REMOTE_ARCHIVE="$($SSH_CMD "ls -1t $REMOTE_BACKUP_DIR/hub-backup-*.tar.gz 2>/dev/null | head -n 1" || true)"
fi

if [[ -z "$LATEST_REMOTE_ARCHIVE" ]]; then
  echo "ERROR: No backup archives found in $REMOTE_BACKUP_DIR on $VPS_HOST." >&2
  exit 1
fi

REMOTE_BASENAME="$(basename "$LATEST_REMOTE_ARCHIVE")"
log "Latest remote backup identified: $REMOTE_BASENAME"

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
=== Dry Run Summary ===
VPS Host:          $VPS_HOST:$VPS_PORT
Remote Backup:     $LATEST_REMOTE_ARCHIVE
Encryption Tool:   $ENCRYPTION_TOOL
Local Destination: $LOCAL_BACKUP_DIR/${REMOTE_BASENAME}.${ENCRYPTION_TOOL}
Status:            OK (dry-run, no files transferred)
EOF
  exit 0
fi

mkdir -p "$LOCAL_BACKUP_DIR"
chmod 700 "$LOCAL_BACKUP_DIR"

TEMP_DIR="$(mktemp -d -t "hub-pull-XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT
chmod 700 "$TEMP_DIR"

LOCAL_TEMP_ARCHIVE="$TEMP_DIR/$REMOTE_BASENAME"
LOCAL_TEMP_CHECKSUM="$TEMP_DIR/${REMOTE_BASENAME}.sha256"

# Pull archive and checksum
if [[ -n "$MOCK_REMOTE_ARCHIVE" ]]; then
  log "Copying mock archive..."
  cp -a "$MOCK_REMOTE_ARCHIVE" "$LOCAL_TEMP_ARCHIVE"
  if [[ -f "${MOCK_REMOTE_ARCHIVE}.sha256" ]]; then
    cp -a "${MOCK_REMOTE_ARCHIVE}.sha256" "$LOCAL_TEMP_CHECKSUM"
  fi
else
  log "Downloading $REMOTE_BASENAME via scp..."
  scp -P "$VPS_PORT" -o BatchMode=yes -o ConnectTimeout=30 \
    "${VPS_USER}@${VPS_HOST}:${LATEST_REMOTE_ARCHIVE}" "$LOCAL_TEMP_ARCHIVE"

  # Try to download checksum file if it exists
  scp -P "$VPS_PORT" -o BatchMode=yes -o ConnectTimeout=10 \
    "${VPS_USER}@${VPS_HOST}:${LATEST_REMOTE_ARCHIVE}.sha256" "$LOCAL_TEMP_CHECKSUM" 2>/dev/null || true
fi

# Verify sha256 checksum
LOCAL_HASH="$(sha256_file "$LOCAL_TEMP_ARCHIVE")"
log "Downloaded archive SHA256: $LOCAL_HASH"

if [[ -f "$LOCAL_TEMP_CHECKSUM" ]]; then
  EXPECTED_HASH="$(awk '{print $1}' "$LOCAL_TEMP_CHECKSUM")"
  if [[ "$LOCAL_HASH" != "$EXPECTED_HASH" ]]; then
    echo "ERROR: Downloaded archive SHA256 does not match remote checksum!" >&2
    echo "Expected: $EXPECTED_HASH" >&2
    echo "Actual:   $LOCAL_HASH" >&2
    exit 1
  fi
  log "Checksum verified ok."
fi

# Encrypt locally on Mac
if [[ "$ENCRYPTION_TOOL" == "age" ]]; then
  ENCRYPTED_FILE="$LOCAL_BACKUP_DIR/${REMOTE_BASENAME}.age"
  log "Encrypting with age -> $ENCRYPTED_FILE..."
  if [[ -n "$AGE_RECIPIENT" ]]; then
    age -r "$AGE_RECIPIENT" -o "$ENCRYPTED_FILE" "$LOCAL_TEMP_ARCHIVE"
  elif [[ -n "$AGE_RECIPIENT_FILE" && -f "$AGE_RECIPIENT_FILE" ]]; then
    age -R "$AGE_RECIPIENT_FILE" -o "$ENCRYPTED_FILE" "$LOCAL_TEMP_ARCHIVE"
  else
    # If no public key provided, use age passphrase encryption securely
    log "Notice: No age recipient key provided. Using passphrase encryption."
    age -p -o "$ENCRYPTED_FILE" "$LOCAL_TEMP_ARCHIVE"
  fi
elif [[ "$ENCRYPTION_TOOL" == "gpg" ]]; then
  ENCRYPTED_FILE="$LOCAL_BACKUP_DIR/${REMOTE_BASENAME}.gpg"
  log "Encrypting with gpg -> $ENCRYPTED_FILE..."
  if [[ -n "$GPG_RECIPIENT" ]]; then
    gpg --batch --yes --encrypt --recipient "$GPG_RECIPIENT" --output "$ENCRYPTED_FILE" "$LOCAL_TEMP_ARCHIVE"
  else
    log "Notice: No GPG recipient provided. Using symmetric AES-256 encryption."
    gpg --batch --yes --symmetric --cipher-algo AES256 --output "$ENCRYPTED_FILE" "$LOCAL_TEMP_ARCHIVE"
  fi
fi

chmod 600 "$ENCRYPTED_FILE"
log "Encrypted backup saved: $ENCRYPTED_FILE (mode 0600)"

# Securely remove temporary unencrypted file
rm -f "$LOCAL_TEMP_ARCHIVE" "$LOCAL_TEMP_CHECKSUM"

# Enforce local weekly retention (keep last N weeks)
log "Enforcing local weekly retention (keeping $KEEP_WEEKS most recent encrypted backups)..."
TOTAL_LOCAL="$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "hub-backup-*.tar.gz.*" -type f | wc -l | tr -d ' ')"
if [[ "$TOTAL_LOCAL" -gt "$KEEP_WEEKS" ]]; then
  PRUNE_COUNT=$((TOTAL_LOCAL - KEEP_WEEKS))
  log "Rotating out $PRUNE_COUNT old local encrypted backups..."
  find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "hub-backup-*.tar.gz.*" -type f | sort | head -n "$PRUNE_COUNT" | while read -r old_enc; do
    log "Removing old weekly backup: $old_enc"
    rm -f "$old_enc"
  done
fi

REMAINING_COUNT="$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "hub-backup-*.tar.gz.*" -type f | wc -l | tr -d ' ')"

cat <<EOF
=== Hub Weekly Pull Receipt ===
Remote Source:  ${VPS_USER}@${VPS_HOST}:${LATEST_REMOTE_ARCHIVE}
Archive SHA256: $LOCAL_HASH
Encrypted File: $ENCRYPTED_FILE
Tool Used:      $ENCRYPTION_TOOL
Local Retained: $REMAINING_COUNT (Weekly rotation policy: $KEEP_WEEKS weeks)
Status:         PULL_AND_ENCRYPT_SUCCEEDED
EOF
