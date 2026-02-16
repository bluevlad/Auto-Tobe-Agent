# Auto-Tobe-Agent 개발 로드맵

## Phase 개요

| Phase | 내용 | 산출물 |
|-------|------|--------|
| **Phase 1** | 프로젝트 기반 구축 | 타입, 설정, 디렉토리 구조 |
| **Phase 2** | Issue 수집/파싱 | issue-parser, project-resolver |
| **Phase 3** | 코드 수정 엔진 | fix-orchestrator, pr-creator |
| **Phase 4** | QA Agent 연동 | verification-reporter, issue-closer |
| **Phase 5** | 통합 테스트 | P3 이슈 3~5건 실전 검증 |
| **Phase 6** | 운영 안정화 | P2/P1 이슈 처리, 전체 프로젝트 확장 |

---

## Phase 1: 프로젝트 기반 구축 (완료)

### 산출물
- `package.json`, `tsconfig.json`, `.gitignore` - 프로젝트 초기화
- `src/types/` - ParsedIssue, ProjectConfig, FixResult, ApprovalPolicyConfig 타입
- `configs/projects.json` - hopenvision 프로젝트 매핑
- `configs/approval-policy.json` - P0~P3 승인 정책
- `src/` 모듈 스텁 파일 - 전체 구조 확보
- `CLAUDE.md`, `README.md`, `docs/` - 문서

---

## Phase 2: Issue 수집/파싱

### 목표
- GitHub Issues에서 이슈 목록 가져오기 (`gh issue list`)
- Issue 본문 파싱 (QA-AGENT-META 및 legacy 텍스트 파싱)
- 프로젝트 매핑 및 Git 상태 확인

### 구현 파일
- `src/issue-parser.ts` - QA-AGENT-META JSON 추출, 라벨 기반 우선순위 판별, 본문 섹션 파싱
- `src/project-resolver.ts` - projects.json 로드, 로컬 경로 검증, Git 상태 확인

### 검증
- hopenvision의 18개 Open Issue를 모두 파싱하여 ParsedIssue 목록 생성
- 우선순위별 정렬 (P0 → P1 → P2 → P3)

---

## Phase 3: 코드 수정 엔진

### 목표
- fix/* 브랜치 생성
- Claude Code CLI를 사용한 코드 수정
- 빌드/테스트 검증
- PR 생성

### 구현 파일
- `src/fix-orchestrator.ts` - 브랜치 생성, Claude Code CLI 호출, 빌드/테스트 실행
- `src/pr-creator.ts` - gh pr create, PR 본문 생성 (Closes #N 포함)
- `strategies/` - 카테고리별 수정 전략 (security, performance, code-quality)
- `templates/spring-boot/` - Java/Spring Boot 수정 패턴 가이드

### 검증
- P3 이슈 1건을 선택하여 수동 실행
- fix 브랜치 생성 → 코드 수정 → 빌드 → PR 생성 확인

---

## Phase 4: QA Agent 연동

### 목표
- QA Agent에 검증 요청 (E2E/API 테스트 트리거)
- 검증 결과 수집
- 검증 성공 시 Issue 종료

### 구현 파일
- `src/verification-reporter.ts` - QA Agent 테스트 트리거, 결과 코멘트

### 검증
- PR 생성 후 QA Agent 테스트 자동 실행 확인
- 테스트 통과 시 Issue 자동 Close 확인

---

## Phase 5: 통합 테스트

### 목표
- hopenvision P3 이슈 3~5건 자동 수정 E2E 테스트
- 전체 파이프라인 검증 (Issue → 파싱 → 수정 → PR → 검증 → Close)

### 검증 대상 이슈
- #36: MapStruct 의존성 미사용
- #37: UserProfileDto 사용자 ID 검증 패턴 중복
- #38: 프론트엔드 API 에러 핸들링 미비

---

## Phase 6: 운영 안정화

### 목표
- P2 이슈 처리 (성능 최적화, 아키텍처 개선)
- P1 이슈 처리 (인증/인가, 보안)
- 나머지 프로젝트 확장 (TeacherHub, AllergyInsight 등)
- 모니터링/알림 체계 구축
