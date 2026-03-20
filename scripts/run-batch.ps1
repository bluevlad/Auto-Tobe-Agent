#
# Auto-Tobe-Agent 배치 실행 스크립트 (Windows PowerShell)
# Windows 작업 스케줄러에서 호출합니다.
#
# 사용법:
#   .\scripts\run-batch.ps1                        # 전체 프로젝트 배치
#   .\scripts\run-batch.ps1 -Project hopenvision   # 특정 프로젝트만
#
# 환경변수:
#   AGENT_HOME   - Auto-Tobe-Agent 설치 경로 (기본: 스크립트 위치의 상위)
#   LOG_DIR      - 로그 디렉토리 (기본: $AGENT_HOME\logs)
#   NODE_BIN     - Node.js 경로 (기본: PATH에서 탐색)

param(
    [string]$Project = ""
)

$ErrorActionPreference = "Stop"

# --- 경로 설정 ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentHome = if ($env:AGENT_HOME) { $env:AGENT_HOME } else { Split-Path -Parent $ScriptDir }
$LogDir = if ($env:LOG_DIR) { $env:LOG_DIR } else { Join-Path $AgentHome "logs" }
$NodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
$DateTag = Get-Date -Format "yyyy-MM-dd"
$TimeTag = Get-Date -Format "HHmmss"

if (-not $NodeBin) {
    Write-Error "Node.js not found. Install Node.js 18+ and add to PATH."
    exit 1
}

# --- 로그 디렉토리 확인 ---
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "batch-${DateTag}-${TimeTag}.log"

# --- Java (Windows) ---
if (-not $env:JAVA_HOME) {
    $JavaPaths = @(
        "C:\Program Files\Java\jdk-21",
        "C:\Program Files\Eclipse Adoptium\jdk-21*",
        "C:\Program Files\Microsoft\jdk-21*"
    )
    foreach ($jp in $JavaPaths) {
        $found = Get-Item $jp -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $env:JAVA_HOME = $found.FullName
            $env:PATH = "$($found.FullName)\bin;$env:PATH"
            break
        }
    }
}

# --- 실행 ---
function Write-Log {
    param([string]$Message)
    $Message | Tee-Object -FilePath $LogFile -Append
}

Write-Log "======================================"
Write-Log "Auto-Tobe-Agent Batch Run (Windows)"
Write-Log "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log "  Home: $AgentHome"
Write-Log "  Node: $NodeBin"
Write-Log "  Project: $(if ($Project) { $Project } else { 'all' })"
Write-Log "  Log: $LogFile"
Write-Log "======================================"

Set-Location $AgentHome

try {
    if ($Project) {
        & $NodeBin dist/index.js batch $Project 2>&1 | Tee-Object -FilePath $LogFile -Append
    } else {
        & $NodeBin dist/index.js batch 2>&1 | Tee-Object -FilePath $LogFile -Append
    }
    $ExitCode = $LASTEXITCODE
} catch {
    Write-Log "ERROR: $_"
    $ExitCode = 1
}

Write-Log ""
Write-Log "Exit code: $ExitCode"
Write-Log "Finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# --- 오래된 로그 정리 (30일 이상) ---
Get-ChildItem -Path $LogDir -Filter "batch-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $ExitCode
