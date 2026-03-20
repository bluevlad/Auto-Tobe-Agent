# Auto-Tobe-Agent 실행 구조 가이드

> macOS launchd 기반 3-Tier 스케줄링 실행 구조
> 작성일: 2026-03-20

---

## 1. 실행 계층

```
macOS launchd (OS 레벨 서비스 관리자)
  │
  ├── .plist 파일 (스케줄 정의)
  │     ~/Library/LaunchAgents/com.bluevlad.auto-tobe-agent.*.plist
  │
  ├── Shell 스크립트 (환경 설정 + 실행)
  │     scripts/run-batch.sh, run-ops.sh
  │
  └── Node.js CLI (비즈니스 로직)
        node dist/index.js <command>
```

### QA Agent와의 비교

| 항목 | QA Agent (Inspector) | Auto-Tobe-Agent (Fixer) |
|------|---------------------|------------------------|
| OS | Windows | macOS |
| Runtime | Java (BatchJob) | Node.js (ESM + TypeScript) |
| 스케줄러 | Windows 작업 스케줄러 | macOS launchd |
| 실행 방식 | JAR 실행 | `node dist/index.js` CLI |
| 설정 파일 | Windows Task XML | `.plist` (Property List XML) |
| 설치 위치 | 작업 스케줄러 GUI | `~/Library/LaunchAgents/` |

---

## 2. launchd 서비스 구성

### 2.1 Tier 1: Docker Monitor

| 항목 | 설정 |
|------|------|
| plist | `com.bluevlad.auto-tobe-agent.monitor.plist` |
| Label | `com.bluevlad.auto-tobe-agent.monitor` |
| 주기 | 매 10분 (StartInterval: 600) |
| 시작 | 로그인 시 즉시 (RunAtLoad: true) |
| 실행 | `scripts/run-ops.sh monitor` → `node dist/index.js docker-monitor` |
| 로그 | `logs/launchd-monitor-stdout.log` |

**역할**: Docker 컨테이너 헬스체크, 로그 이상 감지, 리소스 모니터링, GitHub Issue 자동 생성

### 2.2 Tier 2: Fix 배치

| 항목 | 설정 |
|------|------|
| plist | `com.bluevlad.auto-tobe-agent.plist` |
| Label | `com.bluevlad.auto-tobe-agent` |
| 주기 | 하루 2회 (StartCalendarInterval: 01:00, 05:00) |
| 시작 | 로그인 시 실행 안 함 (RunAtLoad: false) |
| 실행 | `scripts/run-batch.sh` → `node dist/index.js batch` |
| 로그 | `logs/launchd-stdout.log` |

**역할**: Round-Robin으로 이슈 수정, PR 생성, 검증 요청

**시간대 설계 근거**:
- 01:00 — QA Agent 전날 22:00 점검 결과를 처리하는 메인 배치
- 05:00 — 재시도 + 잔여 이슈 처리하는 보충 배치
- 새벽 실행으로 사람 작업과의 충돌 방지 (AGENT_CONFLICT_PREVENTION_GUIDE §2.1)

### 2.3 Tier 3: Deploy

| 항목 | 설정 |
|------|------|
| plist | `com.bluevlad.auto-tobe-agent.deploy.plist` |
| Label | `com.bluevlad.auto-tobe-agent.deploy` |
| 주기 | 매 30분 (StartInterval: 1800) |
| 시작 | 로그인 시 실행 안 함 (RunAtLoad: false) |
| 실행 | `scripts/run-ops.sh deploy` → `node dist/index.js docker-deploy` |
| 로그 | `logs/launchd-deploy-stdout.log` |

**역할**: 머지된 PR 감지 → Docker 빌드/배포 → 헬스체크 → 실패 시 롤백
**시간대 제한**: `schedule.json`의 `allowed_hours`에 의해 06:00~09:00에만 실제 배포 수행

---

## 3. Shell 스크립트 역할

launchd는 최소한의 환경변수만 제공하므로, Shell 스크립트에서 환경을 세팅합니다.

### 3.1 run-batch.sh

```bash
# 실행: ./scripts/run-batch.sh [project]
```

수행 내용:
1. PATH에 homebrew, nvm, node 경로 추가
2. JAVA_HOME 설정 (Spring Boot 프로젝트 빌드용)
3. QA_DASHBOARD_API_KEY 로드 (Docker 컨테이너에서)
4. 타임스탬프 로그 파일 생성 (`logs/batch-YYYY-MM-DD-HHMMSS.log`)
5. `node dist/index.js batch [project]` 실행
6. 30일 이상 오래된 로그 자동 삭제

### 3.2 run-ops.sh

```bash
# 실행: ./scripts/run-ops.sh <mode> [project]
# mode: monitor | fix | deploy | all
```

Tier별 명령어 매핑:
- `monitor` → `node dist/index.js docker-monitor [project]`
- `fix` → `node dist/index.js batch [project]`
- `deploy` → `node dist/index.js docker-deploy [project]`
- `all` → `node dist/index.js ops [project]`

---

## 4. CLI 명령어 (node dist/index.js)

| 명령어 | 설명 | Tier |
|--------|------|------|
| `(없음)` | 상태 표시 (프로젝트, 서비스, 스케줄) | - |
| `scan <project>` | 이슈 스캔 및 파싱 | - |
| `resolve [project]` | 프로젝트 설정 및 Git 상태 | - |
| `preflight <project>` | 실행 전 환경 검증 | - |
| `fix <project> <issue#>` | 단일 이슈 수정 | 2 |
| `fix <project> --auto` | 자동 일괄 수정 | 2 |
| `batch [project]` | 배치 모드 (Round-Robin) | 2 |
| `docker-monitor [project]` | Docker 서비스 모니터링 | 1 |
| `docker-deploy [project]` | 배포 큐 처리 | 3 |
| `ops [project]` | 전체 파이프라인 (1→2→3) | All |
| `history [project]` | 처리 이력 조회 | - |
| `history --reset-failed [project]` | 실패 이력 초기화 | - |

---

## 5. 설치/관리

### 설치

```bash
npm install && npm run build       # 빌드
chmod +x scripts/*.sh              # 스크립트 권한
./scripts/install-launchd.sh       # 3개 서비스 전체 설치
```

### 개별 설치

```bash
./scripts/install-launchd.sh monitor   # Tier 1만
./scripts/install-launchd.sh fix       # Tier 2만
./scripts/install-launchd.sh deploy    # Tier 3만
```

### 관리

```bash
# 상태 확인
launchctl list | grep bluevlad

# 수동 실행 (테스트)
node dist/index.js batch               # 배치 수정
node dist/index.js docker-monitor      # 모니터링
node dist/index.js ops                 # 전체 파이프라인

# 서비스 해제
./scripts/install-launchd.sh uninstall
```

### 재설치 (시간대 변경 후)

```bash
./scripts/install-launchd.sh uninstall
./scripts/install-launchd.sh
```

---

## 6. 로그 구조

```
logs/
├── batch-YYYY-MM-DD-HHMMSS.log          # Fix 배치 실행 로그
├── ops-monitor-YYYY-MM-DD-HHMMSS.log    # 모니터링 실행 로그
├── ops-deploy-YYYY-MM-DD-HHMMSS.log     # 배포 실행 로그
├── launchd-stdout.log                   # Fix 서비스 stdout (append)
├── launchd-stderr.log                   # Fix 서비스 stderr (append)
├── launchd-monitor-stdout.log           # Monitor 서비스 stdout (append)
├── launchd-deploy-stdout.log            # Deploy 서비스 stdout (append)
├── fix-history.json                     # 처리 이력 (영구, 중복 방지)
├── round-robin-state.json               # Round-Robin 상태 (배치 간 연속)
├── monitor-state.json                   # 연속 실패 카운터 (모니터 간 연속)
├── deploy-queue.json                    # 배포 대기열
└── dashboard-queue.json                 # Dashboard 보고 대기열
```

- 타임스탬프 로그: 30일 초과 시 자동 삭제
- JSON 상태 파일: 영구 보존 (매 실행 시 갱신)

---

## 7. 하루 타임라인

```
00:00 ─────────────────────────────────────────────
01:00  [Tier 2] Fix 배치 1차 (6개 프로젝트 × 2이슈 = 최대 12건)
       │ 충돌 검증 → Round-Robin → Claude CLI → PR 생성
05:00  [Tier 2] Fix 배치 2차
06:00  [Tier 3] 배포 시작 (머지된 PR → docker build/deploy)
       │ db → backend → frontend 순서, 실패 시 롤백
09:00  [Tier 3] 배포 종료
       ─── 사람 활동 시간 ───
       [Tier 1] 모니터링만 계속 (매 10분, 읽기 전용)
       사람: PR 리뷰/승인, 직접 개발
18:00 ─────────────────────────────────────────────
       [Tier 1] 모니터링 계속
22:00  QA Agent (Windows): 점검 실행 → GitHub Issue 등록
24:00 ─────────────────────────────────────────────
```

---

## 8. 관련 문서

| 문서 | 위치 | 설명 |
|------|------|------|
| CLAUDE.md | Auto-Tobe-Agent/ | 프로젝트 설정, 아키텍처, 설계 원칙 |
| AGENT_CONFLICT_PREVENTION_GUIDE.md | Claude-Opus-bluevlad/standards/claude-code/ | Agent-Human 충돌 방지 전략 |
| ISSUE_FIX_WORKFLOW.md | Claude-Opus-bluevlad/standards/claude-code/ | 이슈 수정 절차 표준 |
| schedule.json | Auto-Tobe-Agent/configs/ | 3-Tier 스케줄 설정 |
| approval-policy.json | Auto-Tobe-Agent/configs/ | 우선순위별 승인 정책 |
