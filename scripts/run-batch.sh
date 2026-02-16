#!/bin/bash
#
# Auto-Tobe-Agent 배치 실행 스크립트
# macOS launchd 또는 crontab에서 호출합니다.
#
# 사용법:
#   ./scripts/run-batch.sh                    # 전체 프로젝트 배치
#   ./scripts/run-batch.sh hopenvision        # 특정 프로젝트만
#
# 환경변수:
#   AGENT_HOME   - Auto-Tobe-Agent 설치 경로 (기본: 스크립트 위치의 상위)
#   LOG_DIR      - 로그 디렉토리 (기본: $AGENT_HOME/logs)
#   NODE_BIN     - Node.js 경로 (기본: PATH에서 탐색)

set -euo pipefail

# --- 경로 설정 ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_HOME="${AGENT_HOME:-$(dirname "$SCRIPT_DIR")}"
LOG_DIR="${LOG_DIR:-$AGENT_HOME/logs}"
NODE_BIN="${NODE_BIN:-$(which node)}"
DATE_TAG="$(date +%Y-%m-%d)"
TIME_TAG="$(date +%H%M%S)"
PROJECT="${1:-}"

# --- 로그 디렉토리 확인 ---
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/batch-${DATE_TAG}-${TIME_TAG}.log"

# --- PATH 보강 (launchd 환경에서 필요) ---
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH"

# --- 실행 ---
echo "======================================" | tee -a "$LOG_FILE"
echo "Auto-Tobe-Agent Batch Run"            | tee -a "$LOG_FILE"
echo "  Time: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "  Home: $AGENT_HOME"                  | tee -a "$LOG_FILE"
echo "  Node: $NODE_BIN"                    | tee -a "$LOG_FILE"
echo "  Project: ${PROJECT:-all}"           | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE"                     | tee -a "$LOG_FILE"
echo "======================================" | tee -a "$LOG_FILE"

cd "$AGENT_HOME"

if [ -n "$PROJECT" ]; then
  "$NODE_BIN" dist/index.js batch "$PROJECT" 2>&1 | tee -a "$LOG_FILE"
else
  "$NODE_BIN" dist/index.js batch 2>&1 | tee -a "$LOG_FILE"
fi

EXIT_CODE=$?

echo "" | tee -a "$LOG_FILE"
echo "Exit code: $EXIT_CODE" | tee -a "$LOG_FILE"
echo "Finished: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

# --- 오래된 로그 정리 (30일 이상) ---
find "$LOG_DIR" -name "batch-*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
