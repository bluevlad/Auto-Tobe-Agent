# Auto-Tobe-Agent 프로젝트 설정

> Git-First Workflow는 `C:/GIT/CLAUDE.md`에서 자동 상속됩니다.
> 이 파일에는 프로젝트 고유 설정만 작성합니다.

## 프로젝트 개요

- **프로젝트명**: Auto-Tobe-Agent
- **설명**: Autonomous QA Agent가 발견한 GitHub Issues를 자동으로 수정하는 Code Fixer Agent
- **GitHub**: bluevlad/Auto-Tobe-Agent
- **역할**: Issue 파싱 → 코드 수정 → PR 생성 → 검증 요청

## 기술 스택

| 항목 | 기술 |
|------|------|
| Runtime | Node.js (ESM) |
| Language | TypeScript 5.9 |
| 연동 | GitHub CLI (gh), Claude Code CLI |

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
| `index.ts` | 메인 엔트리포인트 | 1 |
| `issue-parser.ts` | GitHub Issue에서 QA-AGENT-META 추출 | 2 |
| `project-resolver.ts` | 프로젝트 경로/설정 매핑 | 2 |
| `fix-orchestrator.ts` | 수정 워크플로우 오케스트레이션 | 3 |
| `pr-creator.ts` | PR 생성 및 관리 | 3 |
| `verification-reporter.ts` | QA Agent 연동 (검증 요청) | 4 |

### 설정 파일 (`configs/`)

| 파일 | 역할 |
|------|------|
| `projects.json` | 대상 프로젝트 매핑 (경로, 기술스택, 빌드 명령어) |
| `approval-policy.json` | 우선순위별 승인 정책 (P0~P3) |

### 타입 정의 (`src/types/`)

| 파일 | 주요 타입 |
|------|----------|
| `issue.ts` | ParsedIssue, QaAgentMeta, Priority, IssueCategory |
| `project.ts` | ProjectConfig, ResolvedProject, TechStack |
| `fix-result.ts` | FixResult, FixStatus, BatchFixResult |
| `approval-policy.ts` | ApprovalPolicyConfig, PriorityPolicy |

## 설계 원칙

1. **Inspector(QA Agent)는 이슈만 생성**, Fixer(이 Agent)는 **수정만 수행**
2. **GitHub Issues = 계약 인터페이스** (두 Agent 간 직접 결합 없음)
3. **우선순위별 차등 자동화** (P0/P1은 사람 승인, P2/P3는 완전 자동)
4. **검증은 항상 Inspector가 수행** (Fixer 자기 검증 배제)

## Do NOT

- 이 Agent에서 GitHub Issue를 직접 생성하지 않을 것 (QA Agent의 역할)
- P0/P1 이슈를 auto-merge하지 않을 것 (사람 승인 필요)
- 대상 프로젝트의 main 브랜치에 직접 커밋하지 않을 것 (반드시 fix/* 브랜치)
- .env 파일이나 자격증명을 커밋하지 않을 것

## 관련 프로젝트

| 프로젝트 | 역할 | 경로 |
|----------|------|------|
| Autonomous-QA-Agent | QA Inspector (이슈 발견) | C:/GIT/Autonomous-QA-Agent |
| Claude-Opus-bluevlad | 표준/규칙 Hub | C:/GIT/Claude-Opus-bluevlad |
| hopenvision | 첫 대상 프로젝트 | C:/GIT/hopenvision |

## 참조 표준

- Commit: C:/GIT/Claude-Opus-bluevlad/standards/git/COMMIT_CONVENTION.md
- Branch: C:/GIT/Claude-Opus-bluevlad/standards/git/BRANCH_CONVENTION.md
- Issue Fix: C:/GIT/Claude-Opus-bluevlad/standards/claude-code/ISSUE_FIX_WORKFLOW.md
