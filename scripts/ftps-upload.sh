#!/usr/bin/env bash
# Upload release files to one Hostinger folder over explicit FTPS, retrying
# dropped connections.
#
# Usage: HOST=… FTP_USER=… FTP_PASS=… scripts/ftps-upload.sh <remote-dir/> <file>...
#
# Hostinger's FTP drops mid-transfer on these multi-hundred-MB uploads
# (`curl: (55) Send failure: Broken pipe` in v2.49.0, `read ECONNRESET` in
# v2.63.0). A dropped connection is not a bad artifact: retry the whole file a
# few times before failing the release. Each attempt re-uploads from byte 0 —
# FTP APPE/REST resume would risk a truncated-then-appended binary, and the
# later HTTP HEAD verification only proves reachability, not integrity.
set -euo pipefail

remote="${1:?remote directory required}"
shift
[ "$#" -gt 0 ] || { echo "ftps-upload: no files to upload" >&2; exit 2; }
: "${HOST:?HOST required}" "${FTP_USER:?FTP_USER required}" "${FTP_PASS:?FTP_PASS required}"
attempts="${FTPS_UPLOAD_ATTEMPTS:-4}"
delay="${FTPS_UPLOAD_RETRY_DELAY:-15}"

upload() {
  local file="$1" attempt=1 trace
  trace="$(mktemp)"
  while :; do
    # --verbose into a file: on failure we print the FTP CONTROL channel
    # (`< 552 Disk full`, `< 421 …`) instead of curl's bare exit code.
    # Secrets stay masked by Actions; only server replies are echoed.
    # --ftp-create-dirs creates the versioned or latest/ folder on first use.
    if curl --fail --silent --show-error --verbose --ssl-reqd --ftp-pasv --ftp-create-dirs \
      --connect-timeout 30 --speed-time 120 --speed-limit 1024 \
      --user "${FTP_USER}:${FTP_PASS}" \
      -T "${file}" \
      "ftp://${HOST}/${remote}" 2>"${trace}"; then
      rm -f "${trace}"
      return 0
    fi
    echo "--- FTP replies for $(basename "${file}") (attempt ${attempt}) ---" >&2
    grep -E '^(< |curl: )' "${trace}" | tail -25 >&2 || true
    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "FTP upload of $(basename "${file}") failed after ${attempt} attempts" >&2
      rm -f "${trace}"
      return 1
    fi
    echo "FTP upload of $(basename "${file}") failed (attempt ${attempt}); retrying in $((attempt * delay))s" >&2
    sleep $((attempt * delay))
    attempt=$((attempt + 1))
  done
}

for file in "$@"; do
  [ -s "${file}" ] || { echo "ftps-upload: missing or empty ${file}" >&2; exit 2; }
  upload "${file}"
  echo "Uploaded $(basename "${file}") to ${remote}"
done
