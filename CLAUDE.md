# Auto-Tobe-Agent 프로젝트 설정

> Git-First Workflow 적용 프로젝트입니다.
> 이 파일에는 프로젝트 고유 설정만 작성합니다.

## 프로젝트 개요

- **프로젝트명**: Auto-Tobe-Agent
- **설명**: GitHub Issues 자동 수정 + Docker 서비스 운영 자동화 Agent
- **GitHub**: bluevlad/Auto-Tobe-Agent
- **역할**: Issue 파싱 → 코드 수정 → PR 생성 → Docker 배포 → 모니터링

## 기술 스택

| 항목 | 기술 |
|------|------|
| Runtime | Node.js (ESM) |
| Language | TypeScript 5.9 |
| 연동 | GitHub CLI (gh), Claude Code CLI, Docker CLI |

## 빌드 및 실행

```bash
npm install          # 의존성 설치
npm run build        # TypeScript 컴파일
npm run type-check   # 타입 검증 (빌드 없이)
npm start            # 에이전트 실행
npm run dev          # 개발 모드 (watch)
```

## 아키텍처

### 핵심 모듈 (`src/`)

| 모듈 | 역할 | Phase |
|------|------|-------|
| `index.ts` | 메인 엔트리포인트 (CLI) | 1 |
| `issue-parser.ts` | GitHub Issue에서 QA-AGENT-META 추출 | 2 |
| `project-resolver.ts` | 프로젝트 경로/설정 매핑 | 2 |
| `fix-orchestrator.ts` | 수정 워크플로우 오케스트레이션 | 3 |
| `pr-creator.ts` | PR 생성 및 관리 | 3 |
| `fix-history.ts` | 처리 이력 관리 및 중복 방지 | 3 |
| `verification-reporter.ts` | QA Agent 연동 (검증 요청) | 4 |
| `docker-monitor.ts` | Docker 서비스 Health Monitor | 7 |
| `issue-correlator.ts` | Docker 이슈 ↔ GitHub Issue 상관관계 | 8 |
| `docker-deployer.ts` | Docker 빌드/배포/롤백 관리 | 9 |
| `round-robin-scheduler.ts` | Multi-Service Round-Robin 배치 스케줄러 | 10 |

### 설정 파일 (`configs/`)

| 파일 | 역할 |
|------|------|
| `projects.json` | 대상 프로젝트 + Docker 서비스 설정 |
| `projects.local.json` | 환경별 경로 오버라이드 (git 미포함) |
| `approval-policy.json` | 우선순위별 승인 정책 (P0~P3) |
| `schedule.json` | 3-Tier 스케줄 설정 (모니터/수정/배포) |

### 타입 정의 (`src/types/`)

| 파일 | 주요 타입 |
|------|----------|
| `issue.ts` | ParsedIssue, QaAgentMeta, Priority, IssueCategory |
| `project.ts` | ProjectConfig, ResolvedProject, TechStack |
| `fix-result.ts` | FixResult, FixStatus, BatchFixResult |
| `approval-policy.ts` | ApprovalPolicyConfig, PriorityPolicy |
| `docker.ts` | DockerServiceConfig, MonitorResult, DeployResult, ScheduleConfig |
| `scheduler.ts` | RoundRobinState, BatchPlan, PlannedWorkItem, ScheduleAdjustment |

## 설계 원칙

1. **Inspector(QA Agent)는 이슈만 생성**, Fixer(이 Agent)는 **수정만 수행**
2. **GitHub Issues = 계약 인터페이스** (두 Agent 간 직접 결합 없음)
3. **우선순위별 차등 자동화** (P0/P1은 사람 승인, P2/P3는 완전 자동)
4. **검증은 항상 Inspector가 수행** (Fixer 자기 검증 배제)
5. **3-Tier 스케줄링**: 모니터링(10분) / 수정(3회/일) / 배포(30분) 분리
6. **보안**: 운영서버 경로/계정 정보는 git에 절대 커밋하지 않음

## Do NOT

- P0/P1 이슈를 auto-merge하지 않을 것 (사람 승인 필요)
- 대상 프로젝트의 main 브랜치에 직접 커밋하지 않을 것 (반드시 fix/* 브랜치)
- .env 파일이나 자격증명을 커밋하지 않을 것
- 운영서버 계정, IP, 경로 등 보안 정보를 git에 포함하지 않을 것
- configs/projects.local.json 등 *.local.* 파일을 커밋하지 않을 것

## 관련 프로젝트

| 프로젝트 | 역할 |
|----------|------|
| Autonomous-QA-Agent | QA Inspector (이슈 발견) |
| hopenvision | 첫 대상 프로젝트 |
