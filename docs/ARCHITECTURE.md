# Auto-Tobe-Agent 아키텍처

## 1. 전체 구조

Auto-Tobe-Agent는 QA Inspector / Code Fixer 분리 아키텍처에서 **Code Fixer** 역할을 담당합니다.

```
┌──────────────────────┐         GitHub Issues          ┌──────────────────────┐
│  QA Inspector Agent  │    (구조화된 이슈 = 계약서)      │   Code Fixer Agent   │
│  (Autonomous-QA-     │ ───────────────────────────→   │   (Auto-Tobe-Agent)  │
│   Agent)             │                                │                      │
│  "문제를 찾는다"       │ ←──────────────────────────── │  "문제를 고친다"       │
│                      │    수정 PR → 검증 테스트 실행    │                      │
├──────────────────────┤                                ├──────────────────────┤
│ - E2E/API 테스트      │                                │ - Issue 읽기/분석     │
│ - 소스코드 정적분석    │                                │ - fix 브랜치 생성     │
│ - 의존성 취약점 스캔   │                                │ - 코드 수정           │
│ - Issue 자동 등록     │                                │ - 테스트 작성/실행     │
│ - 수정 PR 검증        │                                │ - PR 생성            │
│ 권한: READ-ONLY      │                                │ 권한: READ + WRITE   │
└──────────────────────┘                                └──────────────────────┘
```

## 2. 설계 원칙

1. **GitHub Issues = 계약 인터페이스**: 두 Agent는 GitHub Issues를 통해서만 소통
2. **Inspector는 절대 코드를 수정하지 않음**: 발견과 검증만 담당
3. **Fixer는 절대 이슈를 생성하지 않음**: 수정과 PR 생성만 담당
4. **검증은 항상 Inspector가 수행**: Fixer의 자기 검증 배제로 객관성 확보
5. **우선순위별 차등 자동화**: approval-policy.json으로 거버넌스 관리

## 3. 모듈 구성

### 3.1 데이터 흐름

```
GitHub Issue (Open)
       │
       ▼
 ┌─────────────┐
 │ issue-parser │ ← gh issue view, QA-AGENT-META 추출
 └──────┬──────┘
        │ ParsedIssue
        ▼
 ┌──────────────────┐
 │ project-resolver │ ← configs/projects.json
 └──────┬───────────┘
        │ ResolvedProject
        ▼
 ┌──────────────────┐
 │ fix-orchestrator │ ← Claude Code CLI / template-based
 └──────┬───────────┘
        │ FixResult (fix_applied)
        ▼
 ┌────────────┐
 │ pr-creator │ ← gh pr create
 └──────┬─────┘
        │ FixResult (pr_created)
        ▼
 ┌──────────────────────┐
 │ verification-reporter│ ← QA Agent E2E 테스트 트리거
 └──────────────────────┘
        │ FixResult (verification_passed / failed)
        ▼
  Issue Close (성공 시)
```

### 3.2 모듈별 책임

| 모듈 | 입력 | 출력 | 의존성 |
|------|------|------|--------|
| issue-parser | Issue 번호, repo | ParsedIssue | gh CLI |
| project-resolver | 프로젝트명 | ResolvedProject | configs/projects.json |
| fix-orchestrator | ParsedIssue + ResolvedProject | FixResult | Claude Code CLI |
| pr-creator | FixResult | FixResult (PR URL 추가) | gh CLI |
| verification-reporter | FixResult | FixResult (검증 결과) | QA Agent |

## 4. 승인 정책 흐름

```
이슈 발견 (Inspector)
     │
     ▼
 ┌─────────────────┐
 │ 우선순위 판단     │
 │ (P0/P1/P2/P3)   │
 └────────┬────────┘
          │
    ┌─────┼─────┐
    ▼     ▼     ▼
  P0/P1  P2    P3
    │     │     │
    ▼     ▼     ▼
  자동    자동   자동
  수정    수정   수정
    │     │     │
    ▼     ▼     ▼
  자동    자동   자동
  PR     PR    PR
    │     │     │
    ▼     ▼     ▼
  사람   자동   자동
  머지   머지   머지
    │     │     │
    ▼     ▼     ▼
  사람   자동   자동
  배포   배포   배포
 (P0만)
```

## 5. 현재 대상 프로젝트

### hopenvision

| 항목 | 값 |
|------|-----|
| GitHub | bluevlad/hopenvision |
| 기술 스택 | Java 17, Spring Boot 3.2.2, React 19, PostgreSQL 16 |
| Open Issues | 18개 (P0: 1, P1: 5, P2: 6, P3: 6) |
| QA Agent 프로젝트 | hopenvision |

## 6. 참조 문서

- [AGENT_SEPARATION_PLAN.md](../../Autonomous-QA-Agent/docs/AGENT_SEPARATION_PLAN.md) - 원본 설계 문서
- [ISSUE_FIX_WORKFLOW.md](../../Claude-Opus-bluevlad/standards/claude-code/ISSUE_FIX_WORKFLOW.md) - 이슈 수정 워크플로우
- [COMMIT_CONVENTION.md](../../Claude-Opus-bluevlad/standards/git/COMMIT_CONVENTION.md) - 커밋 컨벤션
- [BRANCH_CONVENTION.md](../../Claude-Opus-bluevlad/standards/git/BRANCH_CONVENTION.md) - 브랜치 컨벤션
