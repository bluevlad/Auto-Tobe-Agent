# macOS 운영서버 배치 배포 가이드

Auto-Tobe-Agent를 macOS 운영서버에서 배치 스케줄링으로 운영하기 위한 가이드입니다.

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────┐
│  macOS 운영서버                                       │
│                                                     │
│  launchd (OS 스케줄러)                                │
│    └── com.bluevlad.auto-tobe-agent.plist            │
│          │                                          │
│          ├── 09:00 ──┐                              │
│          ├── 14:00 ──┼── run-batch.sh               │
│          └── 20:00 ──┘     │                        │
│                            ├── node dist/index.js batch │
│                            │     ├── 이슈 스캔       │
│                            │     ├── 이력 확인       │
│                            │     ├── Claude CLI 수정 │
│                            │     ├── 빌드/테스트 검증 │
│                            │     ├── PR 생성        │
│                            │     └── 이력 저장       │
│                            └── logs/batch-*.log     │
│                                                     │
│  fix-history.json (처리 이력, 중복 방지)               │
└─────────────────────────────────────────────────────┘
```

## 1. 사전 준비

### 필수 소프트웨어

```bash
# Node.js (v18+)
node --version

# GitHub CLI (인증 완료)
gh auth status

# Claude Code CLI
claude --version

# Git
git --version
```

### GitHub CLI 인증

```bash
gh auth login
# → GitHub.com 선택
# → HTTPS 선택
# → 브라우저 인증 또는 토큰 입력
```

### Claude Code CLI 설정

```bash
# Claude Code가 자동 모드(-p)에서 파일 수정 권한을 가지도록 설정
# ~/.claude/settings.json에서 permissions 확인
claude --version
```

## 2. 프로젝트 설치

```bash
# 소스 클론
cd ~/GIT
git clone https://github.com/bluevlad/Auto-Tobe-Agent.git
cd Auto-Tobe-Agent

# 의존성 설치
npm install

# 빌드
npm run build

# 동작 확인
node dist/index.js
```

### 대상 프로젝트 클론

```bash
# hopenvision (첫 번째 대상)
cd ~/GIT
git clone https://github.com/bluevlad/hopenvision.git
```

### 설정 파일 확인

`configs/projects.json`의 `local_path`를 macOS 경로로 수정:

```json
{
  "hopenvision": {
    "local_path": "/Users/bluevlad/GIT/hopenvision",
    ...
  }
}
```

> **주의**: Windows 경로(`C:/GIT/...`)와 macOS 경로(`/Users/.../GIT/...`)가 다릅니다.
> 환경별로 `local_path`를 맞춰야 합니다.

## 3. 배치 스크립트 설정

### 실행 권한 부여

```bash
chmod +x scripts/run-batch.sh
```

### 수동 테스트

```bash
# 전체 프로젝트 배치
./scripts/run-batch.sh

# 특정 프로젝트만
./scripts/run-batch.sh hopenvision
```

### 로그 확인

```bash
# 최근 배치 로그
ls -la logs/batch-*.log

# 실시간 확인
tail -f logs/batch-$(date +%Y-%m-%d)-*.log
```

## 4. launchd 스케줄러 등록

macOS의 기본 스케줄러인 `launchd`를 사용합니다.

### plist 설치

```bash
# plist 파일을 LaunchAgents에 복사
cp scripts/com.bluevlad.auto-tobe-agent.plist ~/Library/LaunchAgents/

# plist 경로를 환경에 맞게 수정 (필요시)
# ProgramArguments, WorkingDirectory, AGENT_HOME 등의 경로 확인
```

### 스케줄 등록

```bash
# 등록
launchctl load ~/Library/LaunchAgents/com.bluevlad.auto-tobe-agent.plist

# 확인
launchctl list | grep auto-tobe-agent
```

### 스케줄 해제

```bash
# 해제
launchctl unload ~/Library/LaunchAgents/com.bluevlad.auto-tobe-agent.plist
```

### 즉시 실행 (테스트)

```bash
launchctl start com.bluevlad.auto-tobe-agent
```

## 5. 스케줄 설정

기본 설정은 하루 3회 (09:00, 14:00, 20:00)입니다.

### 스케줄 변경

`scripts/com.bluevlad.auto-tobe-agent.plist`의 `StartCalendarInterval`을 수정합니다.

```xml
<!-- 예: 매일 06:00, 12:00, 18:00, 23:00 (4회) -->
<key>StartCalendarInterval</key>
<array>
    <dict>
        <key>Hour</key><integer>6</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
        <key>Hour</key><integer>12</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
        <key>Hour</key><integer>18</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
        <key>Hour</key><integer>23</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
</array>
```

변경 후 재등록:

```bash
launchctl unload ~/Library/LaunchAgents/com.bluevlad.auto-tobe-agent.plist
launchctl load ~/Library/LaunchAgents/com.bluevlad.auto-tobe-agent.plist
```

### crontab 대안

launchd 대신 crontab을 사용할 수도 있습니다:

```bash
crontab -e

# 매일 09:00, 14:00, 20:00 실행
0 9,14,20 * * * /Users/bluevlad/GIT/Auto-Tobe-Agent/scripts/run-batch.sh >> /Users/bluevlad/GIT/Auto-Tobe-Agent/logs/cron.log 2>&1
```

## 6. CLI 명령어

### 배치 관련

```bash
# 배치 실행 (이력 관리 포함, 중복 처리 방지)
node dist/index.js batch                    # 전체 프로젝트
node dist/index.js batch hopenvision        # 특정 프로젝트

# 처리 이력 조회
node dist/index.js history                  # 전체
node dist/index.js history hopenvision      # 특정 프로젝트
```

### 수동 실행 (긴급 대응)

```bash
# P0/P1 긴급 이슈 즉시 수정
node dist/index.js fix hopenvision 25

# 이슈 스캔만 (수정 없이 상태 확인)
node dist/index.js scan hopenvision
```

## 7. 이력 관리

### 처리 이력 파일

`logs/fix-history.json`에 저장됩니다:

```json
{
  "version": "1.0.0",
  "lastRunAt": "2026-02-16T09:00:00.000Z",
  "entries": {
    "hopenvision#39": {
      "issueNumber": 39,
      "project": "hopenvision",
      "status": "pr_created",
      "prUrl": "https://github.com/bluevlad/hopenvision/pull/42",
      "processedAt": "2026-02-16T09:05:30.000Z"
    }
  }
}
```

### 중복 처리 방지

- `batch` 명령은 이미 성공적으로 처리된 이슈(pr_created, merged, deployed 등)를 건너뜁니다.
- `failed` 상태의 이슈는 다음 배치에서 다시 시도합니다.
- `fix` 명령(수동 실행)은 이력에 관계없이 항상 실행됩니다.

## 8. 모니터링

### 로그 확인

```bash
# 최근 배치 결과
tail -50 logs/batch-$(date +%Y-%m-%d)-*.log

# launchd 로그
tail -20 logs/launchd-stdout.log
tail -20 logs/launchd-stderr.log

# 처리 이력 요약
node dist/index.js history
```

### 문제 해결

| 증상 | 확인 사항 |
|------|----------|
| 배치가 실행 안 됨 | `launchctl list \| grep auto-tobe` 확인 |
| gh 인증 오류 | `gh auth status` 확인 |
| Claude CLI 오류 | `claude --version` 확인, 권한 설정 확인 |
| 빌드 실패 | 대상 프로젝트 수동 빌드 테스트 |
| Node 못 찾음 | plist의 PATH에 node 경로 추가 |

### gradlew 권한 (macOS)

macOS에서 Gradle 프로젝트 빌드 시:

```bash
# hopenvision의 gradlew에 실행 권한 부여
chmod +x ~/GIT/hopenvision/api/gradlew
```

## 9. 프로젝트 추가

새 프로젝트를 배치 대상에 추가하려면:

1. `configs/projects.json`에 프로젝트 설정 추가
2. 대상 프로젝트를 macOS에 클론
3. 빌드 환경 확인 (JDK, Node.js 등)
4. `node dist/index.js scan <project>` 로 이슈 스캔 테스트
5. 다음 배치부터 자동 포함됨
