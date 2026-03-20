#
# Auto-Tobe-Agent Windows 작업 스케줄러 등록
# 관리자 권한 PowerShell에서 실행하세요.
#
# 사용법:
#   .\scripts\install-task-scheduler.ps1              # 전체 설치
#   .\scripts\install-task-scheduler.ps1 -Tier monitor  # 모니터링만
#   .\scripts\install-task-scheduler.ps1 -Tier fix      # 이슈 수정만
#   .\scripts\install-task-scheduler.ps1 -Tier deploy   # 배포만
#   .\scripts\install-task-scheduler.ps1 -Uninstall     # 전체 해제

param(
    [ValidateSet("all", "monitor", "fix", "deploy")]
    [string]$Tier = "all",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentHome = Split-Path -Parent $ScriptDir
$TaskFolder = "\AutoTobeAgent"
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodeBin -and -not $Uninstall) {
    Write-Error "Node.js not found. Install Node.js 18+ and add to PATH."
    exit 1
}

Write-Host "Auto-Tobe-Agent Task Scheduler Installer"
Write-Host "  Agent Home: $AgentHome"
Write-Host "  Node: $NodeBin"
Write-Host "  Mode: $(if ($Uninstall) { 'Uninstall' } else { "Install ($Tier)" })"
Write-Host ""

# --- 작업 정의 ---
$Tasks = @{
    "monitor" = @{
        Name        = "Auto-Tobe-Agent Monitor"
        Description = "Tier 1: Docker 서비스 헬스체크 (매 10분)"
        Script      = Join-Path $ScriptDir "run-ops.ps1"
        Arguments   = "-Mode monitor"
        Trigger     = New-ScheduledTaskTrigger -Once -At "00:00" -RepetitionInterval (New-TimeSpan -Minutes 10)
    }
    "fix" = @{
        Name        = "Auto-Tobe-Agent Fix Batch"
        Description = "Tier 2: 이슈 수정 배치 (01:00, 05:00)"
        Script      = Join-Path $ScriptDir "run-batch.ps1"
        Arguments   = ""
        Triggers    = @(
            New-ScheduledTaskTrigger -Daily -At "01:00",
            New-ScheduledTaskTrigger -Daily -At "05:00"
        )
    }
    "deploy" = @{
        Name        = "Auto-Tobe-Agent Deploy"
        Description = "Tier 3: Docker 배포 큐 처리 (매 30분)"
        Script      = Join-Path $ScriptDir "run-ops.ps1"
        Arguments   = "-Mode deploy"
        Trigger     = New-ScheduledTaskTrigger -Once -At "00:00" -RepetitionInterval (New-TimeSpan -Minutes 30)
    }
}

# --- 해제 ---
if ($Uninstall) {
    foreach ($task in $Tasks.Values) {
        $existing = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
            Write-Host "  Removed: $($task.Name)"
        }
    }
    Write-Host "Done."
    exit 0
}

# --- 로그 디렉토리 생성 ---
$LogDir = Join-Path $AgentHome "logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# --- 설치할 Tier 결정 ---
$TiersToInstall = if ($Tier -eq "all") { @("monitor", "fix", "deploy") } else { @($Tier) }

foreach ($tierName in $TiersToInstall) {
    $task = $Tasks[$tierName]

    # 기존 작업 제거
    $existing = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
        Write-Host "  Removed existing: $($task.Name)"
    }

    # 실행 액션
    $actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$($task.Script)`""
    if ($task.Arguments) {
        $actionArgs += " $($task.Arguments)"
    }
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $AgentHome

    # 트리거
    if ($task.Triggers) {
        $triggers = $task.Triggers
    } else {
        $triggers = @($task.Trigger)
    }

    # 설정
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 3)

    # 등록
    Register-ScheduledTask `
        -TaskName $task.Name `
        -Description $task.Description `
        -Action $action `
        -Trigger $triggers `
        -Settings $settings `
        -RunLevel Highest | Out-Null

    Write-Host "  Installed: $($task.Name)"
}

Write-Host ""
Write-Host "Installed tasks:"
Get-ScheduledTask | Where-Object { $_.TaskName -like "*Auto-Tobe*" } | Format-Table TaskName, State -AutoSize
Write-Host "Done."
