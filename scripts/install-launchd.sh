#!/bin/bash
#
# launchd plist 설치 헬퍼
# plist 파일의 ${AGENT_HOME}을 실제 경로로 치환하여 설치합니다.
#
# 사용법:
#   ./scripts/install-launchd.sh           # 전체 설치
#   ./scripts/install-launchd.sh monitor   # 모니터링만
#   ./scripts/install-launchd.sh uninstall # 전체 해제

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_HOME="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
MODE="${1:-install}"

PLISTS=(
  "com.bluevlad.auto-tobe-agent.plist"
  "com.bluevlad.auto-tobe-agent.monitor.plist"
  "com.bluevlad.auto-tobe-agent.deploy.plist"
)

echo "Auto-Tobe-Agent launchd installer"
echo "  AGENT_HOME: $AGENT_HOME"
echo "  HOME: $HOME"
echo "  Mode: $MODE"
echo ""

if [ "$MODE" = "uninstall" ]; then
  for plist in "${PLISTS[@]}"; do
    label="${plist%.plist}"
    if launchctl list | grep -q "$label" 2>/dev/null; then
      echo "Unloading $label..."
      launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || true
    fi
    if [ -f "$LAUNCH_AGENTS_DIR/$plist" ]; then
      rm "$LAUNCH_AGENTS_DIR/$plist"
      echo "Removed $plist"
    fi
  done
  echo "Done."
  exit 0
fi

# 실행 권한 부여
chmod +x "$SCRIPT_DIR/run-batch.sh"
chmod +x "$SCRIPT_DIR/run-ops.sh"

mkdir -p "$LAUNCH_AGENTS_DIR"
mkdir -p "$AGENT_HOME/logs"

# 특정 plist만 설치하는 경우
case "$MODE" in
  monitor)
    PLISTS=("com.bluevlad.auto-tobe-agent.monitor.plist")
    ;;
  deploy)
    PLISTS=("com.bluevlad.auto-tobe-agent.deploy.plist")
    ;;
  fix|batch)
    PLISTS=("com.bluevlad.auto-tobe-agent.plist")
    ;;
  install|all)
    # 전체 설치
    ;;
  *)
    echo "Usage: $0 {install|monitor|deploy|fix|uninstall}"
    exit 1
    ;;
esac

for plist in "${PLISTS[@]}"; do
  label="${plist%.plist}"
  src="$SCRIPT_DIR/$plist"

  if [ ! -f "$src" ]; then
    echo "SKIP: $src not found"
    continue
  fi

  # 기존 서비스 해제
  if launchctl list | grep -q "$label" 2>/dev/null; then
    echo "Unloading existing $label..."
    launchctl unload "$LAUNCH_AGENTS_DIR/$plist" 2>/dev/null || true
  fi

  # ${AGENT_HOME}과 ${HOME}을 실제 경로로 치환
  sed \
    -e "s|\${AGENT_HOME}|$AGENT_HOME|g" \
    -e "s|\${HOME}|$HOME|g" \
    "$src" > "$LAUNCH_AGENTS_DIR/$plist"

  echo "Installed: $LAUNCH_AGENTS_DIR/$plist"

  # 서비스 등록
  launchctl load "$LAUNCH_AGENTS_DIR/$plist"
  echo "Loaded: $label"
done

echo ""
echo "Installed services:"
launchctl list | grep "auto-tobe-agent" || echo "  (none found - may need login/logout)"
echo ""
echo "Done."
