# Auto-Tobe-Agent

Autonomous Code Fixer & Docker Ops Agent - GitHub Issues 자동 수정 및 Docker 서비스 운영 자동화

## 개요

| 항목 | 내용 |
|------|------|
| **역할** | Code Fixer + Docker Ops (코드 수정 + 서비스 운영) |
| **파트너** | [Autonomous-QA-Agent](https://github.com/bluevlad/Autonomous-QA-Agent) (이슈 발견 전담) |
| **계약** | GitHub Issues (QA-AGENT-META 구조화 메타데이터) |
| **대상** | hopenvision, AllergyInsight, EduFit, NewsLetterPlatform, unmong-main, StandUp |

## 아키텍처

```
                         Docker 서비스 모니터링
                        ┌──────────────────────┐
                        │  docker-monitor.ts    │ Tier 1 (매 10분)
                        │  - Health check       │
                        │  - 로그 이상 감지      │
                        │  - 리소스 모니터링      │
                        └──────────┬───────────┘
                                   │ DockerIssue[]
                                   ▼
QA Inspector Agent      ┌──────────────────────┐      Code Fixer Agent
(Autonomous-QA-Agent)   │  issue-correlator.ts  │      (Auto-Tobe-Agent)
"문제를 찾는다"          │  - 이슈 상관관계 분석    │     "문제를 고친다"
                        │  - 중복 이슈 감지       │
 E2E/API 테스트          │  - 우선순위 산정        │      Issue 파싱/분석
 소스코드 정적분석  ─→    └──────────┬───────────┘      코드 수정
 의존성 취약점 스캔       GitHub     │ ParsedIssue       fix 브랜치 생성
 Issue 자동 등록     ─── Issues ───→│───────────────→    PR 생성
 수정 PR 검증       ←───── (계약) ──│────────────────    검증 요청
                                   ▼
                        ┌──────────────────────┐
                        │  docker-deployer.ts   │ Tier 3 (매 30분)
                        │  - Rolling deploy     │
                        │  - Health check 후 전환 │
                        │  - 실패 시 자동 롤백    │
                        └──────────────────────┘
```

## 3-Tier 스케줄링

| Tier | 모듈 | 주기 | 역할 |
|------|------|------|------|
| **Tier 1** | docker-monitor | 매 10분 | Docker 서비스 상태 점검, 이상 감지, 자동 재시작 |
| **Tier 2** | batch (fix) | 하루 2회 (01/05시, 새벽) | GitHub Issue 스캔 → 코드 수정 → PR 생성 |
| **Tier 3** | docker-deploy | 매 30분 | 머지된 PR 확인 → Docker 빌드/배포 → 롤백 |

## 승인 정책

| 우선순위 | 수정 | PR | 머지 | 배포 |
|----------|------|----|------|------|
| P0 (보안) | 자동 | 자동 | 사람 승인 | 사람 승인 |
| P1 (긴급) | 자동 | 자동 | 사람 승인 | 자동 |
| P2 (계획) | 자동 | 자동 | 자동 | 자동 |
| P3 (개선) | 자동 | 자동 | 자동 | 자동 |

## 설치 및 실행

```bash
npm install          # 의존성 설치
npm run build        # TypeScript 컴파일
npm start            # 에이전트 상태 표시
```

### CLI 명령어

```bash
# 기존 (코드 수정)
npm start -- scan <project>            # 이슈 스캔
npm start -- resolve <project>         # 프로젝트 상태
npm start -- fix <project> <issue#>    # 단일 이슈 수정
npm start -- fix <project> --auto      # 자동 일괄 수정
npm start -- batch [project]           # 배치 모드

# 신규 (Docker 운영)
npm start -- docker-monitor [project]  # Docker 서비스 모니터링
npm start -- docker-deploy [project]   # Docker 배포 큐 처리
npm start -- ops [project]             # 전체 파이프라인 (모니터+수정+배포)

# 이력 관리
npm start -- history [project]         # 처리 이력 조회
```

### 배치 스케줄링 (macOS launchd)

```bash
chmod +x scripts/*.sh
./scripts/install-launchd.sh           # 전체 설치
./scripts/install-launchd.sh monitor   # 모니터링만
./scripts/install-launchd.sh uninstall # 전체 해제
```

## 프로젝트 구조

```
Auto-Tobe-Agent/
├── src/
│   ├── index.ts                    # 메인 엔트리포인트 (CLI)
│   ├── types/                      # TypeScript 타입 정의
│   │   ├── index.ts                # 타입 re-exports
│   │   ├── issue.ts                # 이슈 타입
│   │   ├── project.ts              # 프로젝트 설정 타입
│   │   ├── fix-result.ts           # 수정 결과 타입
│   │   ├── approval-policy.ts      # 승인 정책 타입
│   │   └── docker.ts               # Docker 모니터링/배포 타입 (신규)
│   ├── issue-parser.ts             # GitHub Issue 파싱
│   ├── project-resolver.ts         # 프로젝트 매핑
│   ├── fix-orchestrator.ts         # 수정 오케스트레이션
│   ├── pr-creator.ts               # PR 생성
│   ├── fix-history.ts              # 처리 이력 관리
│   ├── verification-reporter.ts    # 검증 요청
│   ├── docker-monitor.ts           # Docker 서비스 모니터링
│   ├── issue-correlator.ts         # 이슈 상관관계 분석
│   ├── docker-deployer.ts          # Docker 배포 관리
│   └── round-robin-scheduler.ts    # Multi-Service Round-Robin 스케줄러
├── configs/
│   ├── projects.json               # 대상 프로젝트 + Docker 서비스 설정
│   ├── projects.local.json.example # 로컬 경로 오버라이드 예시
│   ├── approval-policy.json        # 승인 정책
│   ├── schedule.json               # 3-Tier 스케줄 설정
│   └── dashboard.json              # QA Dashboard API 설정
├── scripts/
│   ├── run-batch.sh                # 이슈 수정 배치 스크립트
│   ├── run-ops.sh                  # 3-Tier 운영 스크립트 (신규)
│   ├── install-launchd.sh          # launchd 설치 헬퍼 (신규)
│   ├── com.bluevlad.auto-tobe-agent.plist          # Tier 2 (이슈 수정)
│   ├── com.bluevlad.auto-tobe-agent.monitor.plist  # Tier 1 (모니터링)
│   └── com.bluevlad.auto-tobe-agent.deploy.plist   # Tier 3 (배포)
├── strategies/                     # 카테고리별 수정 전략
├── templates/                      # 기술스택별 수정 패턴
└── docs/                           # 문서
```

## 서비스 추가

`configs/projects.json`에 새 프로젝트 블록을 추가하면 다음 배치부터 자동 포함됩니다.

환경별 경로는 `configs/projects.local.json`에서 오버라이드하세요 (git에 커밋되지 않음).

## 보안

- `.env`, 자격증명, SSH 키 등은 `.gitignore`에 의해 커밋 차단
- 운영서버 경로는 `projects.local.json`에서 관리 (git 미포함)
- launchd plist의 `${AGENT_HOME}` 은 `install-launchd.sh`가 설치 시 치환

## 문서

- [CLAUDE.md](CLAUDE.md) — 프로젝트 설정 및 아키텍처
- [docs/README.md](docs/README.md) — 문서 목록 및 참조

### 참조 표준 (Claude-Opus-bluevlad)

- [AGENT_CONFLICT_PREVENTION_GUIDE.md](https://github.com/bluevlad/Claude-Opus-bluevlad/blob/main/standards/claude-code/AGENT_CONFLICT_PREVENTION_GUIDE.md) — Agent-Human 충돌 방지
- [ISSUE_FIX_WORKFLOW.md](https://github.com/bluevlad/Claude-Opus-bluevlad/blob/main/standards/claude-code/ISSUE_FIX_WORKFLOW.md) — 이슈 수정 워크플로우
- [COMMIT_CONVENTION.md](https://github.com/bluevlad/Claude-Opus-bluevlad/blob/main/standards/git/COMMIT_CONVENTION.md) — 커밋 메시지 규칙
