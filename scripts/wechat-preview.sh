#!/usr/bin/env bash
set -euo pipefail

: "${WECHAT_APP_ID:?Set the WECHAT_APP_ID variable in the wechat-preview environment}"
: "${WECHAT_UPLOAD_KEY:?Set the WECHAT_UPLOAD_KEY secret in the wechat-preview environment}"
: "${RUNNER_TEMP:?GitHub Actions runner temporary directory is required}"

if [[ ! "$WECHAT_APP_ID" =~ ^wx[[:xdigit:]]{16}$ ]]; then
  printf 'WECHAT_APP_ID must be a Mini Program AppID.\n' >&2
  exit 1
fi

cli="$RUNNER_TEMP/wechat-ci/node_modules/.bin/miniprogram-ci"
work_dir="$(mktemp -d "$RUNNER_TEMP/wechat-project.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
project_dir="$work_dir/project"
key_file="$work_dir/upload.key"
output_dir="$RUNNER_TEMP/wechat-preview"
output_file="$output_dir/preview.jpg"
mkdir -p -- "$project_dir/dist" "$output_dir"
rm -f -- "$output_file"
cp -R -- dist/miniprogram "$project_dir/dist/miniprogram"

node - "$project_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const project = JSON.parse(fs.readFileSync('project.config.json', 'utf8'));
project.appid = process.env.WECHAT_APP_ID;
project.miniprogramRoot = 'dist/miniprogram/';
fs.writeFileSync(
  path.join(process.argv[2], 'project.config.json'),
  JSON.stringify(project, null, 2),
);
NODE

(
  umask 077
  printf '%s\n' "$WECHAT_UPLOAD_KEY" > "$key_file"
)
unset WECHAT_UPLOAD_KEY

"$cli" preview \
  --pp "$project_dir" \
  --pkp "$key_file" \
  --appid "$WECHAT_APP_ID" \
  --uv "0.0.${GITHUB_RUN_NUMBER:-0}" \
  -r 1 \
  --use-project-config true \
  --qrcode-format image \
  --qrcode-output-dest "$output_file"

test -s "$output_file"
