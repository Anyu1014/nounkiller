#!/usr/bin/env bash
# NounKiller · 构建脚本
#   ./src/tool/build.sh [all|web|apk|ipa|test|clean]
# 产物统一进入 build/latest/，旧版本自动归档到 build/history/<时间戳>/。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/src"
BUILD="$ROOT/build"
CACHE="$ROOT/.cache"
IOS="$SRC/ios"

GRADLE="${GRADLE_BIN:-/Users/y/.gradle/wrapper/dists/gradle-8.14.3-all/10utluxaxniiv4wxiphsi49nj/gradle-8.14.3/bin/gradle}"
XCODEBUILD="${XCODEBUILD_BIN:-/Users/y/toolchains/bin/xcodebuild}"
XCODEGEN="${XCODEGEN_BIN:-/Users/y/toolchains/bin/xcodegen}"
NODE="${NODE_BIN:-/Users/y/toolchains/bin/node}"

# 版本策略：只递增 major.minor，patch 恒为 0（如 1.3.0 → 1.4.0）
VERSION="$(sed -nE "s/.*versionName ['\"]([^'\"]+)['\"].*/\1/p" "$SRC/android/app/build.gradle" | head -1)"
VERSION="${VERSION:-1.4.0}"
APK_NAME="NounKiller-$VERSION.apk"
IPA_NAME="NounKiller-$VERSION.ipa"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

clean() {
  say "清理 .cache"
  rm -rf "$CACHE"/*
}

sync_web() {
  say "同步 web → Android assets / iOS www"
  mkdir -p "$SRC/android/app/src/main/assets/www" "$IOS/NounKiller/www"
  rsync -a --delete --exclude _worker.js "$SRC/web/" "$SRC/android/app/src/main/assets/www/"
  rsync -a --delete --exclude _worker.js "$SRC/web/" "$IOS/NounKiller/www/"
}

# 同名产物内容不同 → 先把旧文件搬进 history，再放新文件
publish() {
  local file="$1" name="$2"
  mkdir -p "$BUILD/latest" "$BUILD/history"
  if [ -f "$BUILD/latest/$name" ]; then
    if cmp -s "$file" "$BUILD/latest/$name"; then
      say "未变化：$name"
      return
    fi
    local dir="$BUILD/history/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir"
    mv "$BUILD/latest/$name" "$dir/"
    say "旧版归档 → $dir/$name"
  fi
  # latest 只保留当前版本：同扩展名的其他版本一并归档
  local ext="${name##*.}" old
  shopt -s nullglob
  for old in "$BUILD/latest"/NounKiller-*\.$ext; do
    [ "$(basename "$old")" = "$name" ] && continue
    local dir2="$BUILD/history/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir2"
    mv "$old" "$dir2/"
    say "旧版归档 → $dir2/$(basename "$old")"
  done
  shopt -u nullglob
  cp "$file" "$BUILD/latest/$name"
  say "已发布 → build/latest/$name"
}

build_web() {
  sync_web
  mkdir -p "$BUILD/latest"
  if [ -d "$BUILD/latest/dist" ]; then
    local dir="$BUILD/history/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir"
    mv "$BUILD/latest/dist" "$dir/dist"
    say "旧 web 归档 → $dir/dist"
  fi
  rsync -a "$SRC/web/" "$BUILD/latest/dist/"
  say "已发布 → build/latest/dist/（静态站点，直接部署或用任意静态服务器打开）"
}

build_apk() {
  sync_web
  say "构建 Android release APK"
  "$GRADLE" --offline --no-daemon -q -p "$SRC/android" assembleRelease
  publish "$SRC/android/app/build/outputs/apk/release/app-release.apk" "$APK_NAME"
}

build_ipa() {
  sync_web
  say "生成 Xcode 工程"
  ( cd "$IOS" && "$XCODEGEN" generate >/dev/null )
  say "归档 iOS Release"
  rm -rf "$CACHE/NounKiller.xcarchive" "$CACHE/ios-export"
  "$XCODEBUILD" -project "$IOS/NounKiller.xcodeproj" -scheme NounKiller \
    -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
    -archivePath "$CACHE/NounKiller.xcarchive" -allowProvisioningUpdates archive -quiet
  say "导出 IPA"
  "$XCODEBUILD" -exportArchive -archivePath "$CACHE/NounKiller.xcarchive" \
    -exportPath "$CACHE/ios-export" -exportOptionsPlist "$SRC/tool/ExportOptions.plist" \
    -allowProvisioningUpdates -quiet
  publish "$CACHE/ios-export/NounKiller.ipa" "$IPA_NAME"
}

run_tests() {
  say "运行核心逻辑测试"
  "$NODE" --test "$SRC/test/run.mjs"
}

case "${1:-all}" in
  all)   run_tests; build_web; build_apk; build_ipa ;;
  web)   build_web ;;
  apk)   build_apk ;;
  ipa)   build_ipa ;;
  test)  run_tests ;;
  clean) clean ;;
  *) echo "用法: $0 [all|web|apk|ipa|test|clean]" >&2; exit 1 ;;
esac
