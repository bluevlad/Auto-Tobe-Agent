#!/bin/bash
#
# Auto-Tobe-Agent Ops Runner
# 3-Tier 분리 실행을 지원합니다.
#
# 사용법:
#   ./scripts/run-ops.sh monitor [project]   # Tier 1: Docker 모니터링
#   ./scripts/run-ops.sh fix [project]       # Tier 2: 이슈 수정 배치
#   ./scripts/run-ops.sh deploy [project]    # Tier 3: Docker 배포
#   ./scripts/run-ops.sh all [project]       # 전체 파이프라인
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
MODE="${1:-all}"
PROJECT="${2:-}"

# --- 로그 디렉토리 확인 ---
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/ops-${MODE}-${DATE_TAG}-${TIME_TAG}.log"

# --- PATH 보강 (launchd 환경에서 필요) ---
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:$PATH"

# --- Java (Homebrew OpenJDK 21) ---
if [ -z "${JAVA_HOME:-}" ] && [ -d "/opt/homebrew/opt/openjdk@21" ]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# --- 실행 ---
echo "======================================" | tee -a "$LOG_FILE"
echo "Auto-Tobe-Agent Ops Runner"            | tee -a "$LOG_FILE"
echo "  Time: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
echo "  Mode: $MODE"                         | tee -a "$LOG_FILE"
echo "  Home: $AGENT_HOME"                   | tee -a "$LOG_FILE"
echo "  Node: $NODE_BIN"                     | tee -a "$LOG_FILE"
echo "  Project: ${PROJECT:-all}"            | tee -a "$LOG_FILE"
echo "  Log: $LOG_FILE"                      | tee -a "$LOG_FILE"
echo "======================================" | tee -a "$LOG_FILE"

cd "$AGENT_HOME"

PROJECT_ARG=""
if [ -n "$PROJECT" ]; then
  PROJECT_ARG="$PROJECT"
fi

case "$MODE" in
  monitor)
    "$NODE_BIN" dist/index.js docker-monitor $PROJECT_ARG 2>&1 | tee -a "$LOG_FILE"
    ;;
  fix)
    "$NODE_BIN" dist/index.js batch $PROJECT_ARG 2>&1 | tee -a "$LOG_FILE"
    ;;
  deploy)
    "$NODE_BIN" dist/index.js docker-deploy $PROJECT_ARG 2>&1 | tee -a "$LOG_FILE"
    ;;
  all)
    "$NODE_BIN" dist/index.js ops $PROJECT_ARG 2>&1 | tee -a "$LOG_FILE"
    ;;
  *)
    echo "Unknown mode: $MODE" | tee -a "$LOG_FILE"
    echo "Usage: $0 {monitor|fix|deploy|all} [project]" | tee -a "$LOG_FILE"
    exit 1
    ;;
esac

EXIT_CODE=$?

echo "" | tee -a "$LOG_FILE"
echo "Exit code: $EXIT_CODE" | tee -a "$LOG_FILE"
echo "Finished: $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"

# --- 오래된 로그 정리 (30일 이상) ---
find "$LOG_DIR" -name "ops-*.log" -mtime +30 -delete 2>/dev/null || true
find "$LOG_DIR" -name "batch-*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
