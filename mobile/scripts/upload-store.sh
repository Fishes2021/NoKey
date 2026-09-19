#!/bin/sh
# 在上传前强制核对归档符号；由 Xcode 使用已登录的发行账号签名。
set -eu
if [ "$#" -ne 3 ]; then
  echo '用法：sh upload-store.sh 归档.xcarchive UploadOptions.plist 输出目录' >&2
  exit 2
fi
python3 "$(dirname "$0")/prepare-store-symbols.py" "$1"
python3 - "$2" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as stream:
    options = plistlib.load(stream)
assert options.get('uploadSymbols') is True, '必须启用 uploadSymbols'
assert options.get('destination') == 'upload', '必须使用 upload 目标'
PY
exec xcodebuild -exportArchive -archivePath "$1" -exportOptionsPlist "$2" \
  -exportPath "$3" -allowProvisioningUpdates
