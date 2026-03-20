#
# Auto-Tobe-Agent Ops Runner (Windows PowerShell)
# 3-Tier 분리 실행을 지원합니다.
#
# 사용법:
#   .\scripts\run-ops.ps1 -Mode monitor              # Tier 1: Docker 모니터링
#   .\scripts\run-ops.ps1 -Mode fix                   # Tier 2: 이슈 수정 배치
#   .\scripts\run-ops.ps1 -Mode deploy                # Tier 3: Docker 배포
#   .\scripts\run-ops.ps1 -Mode all                   # 전체 파이프라인
#   .\scripts\run-ops.ps1 -Mode monitor -Project hopenvision  # 특정 프로젝트

param(
    [ValidateSet("monitor", "fix", "deploy", "all")]
    [string]$Mode = "all",
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

$LogFile = Join-Path $LogDir "ops-${Mode}-${DateTag}-${TimeTag}.log"

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
Write-Log "Auto-Tobe-Agent Ops Runner (Windows)"
Write-Log "  Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log "  Mode: $Mode"
Write-Log "  Home: $AgentHome"
Write-Log "  Node: $NodeBin"
Write-Log "  Project: $(if ($Project) { $Project } else { 'all' })"
Write-Log "  Log: $LogFile"
Write-Log "======================================"

Set-Location $AgentHome

$CommandMap = @{
    "monitor" = "docker-monitor"
    "fix"     = "batch"
    "deploy"  = "docker-deploy"
    "all"     = "ops"
}

$CliCommand = $CommandMap[$Mode]
$Args = @("dist/index.js", $CliCommand)
if ($Project) { $Args += $Project }

try {
    & $NodeBin @Args 2>&1 | Tee-Object -FilePath $LogFile -Append
    $ExitCode = $LASTEXITCODE
} catch {
    Write-Log "ERROR: $_"
    $ExitCode = 1
}

Write-Log ""
Write-Log "Exit code: $ExitCode"
Write-Log "Finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# --- 오래된 로그 정리 (30일 이상) ---
Get-ChildItem -Path $LogDir -Filter "ops-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $ExitCode
