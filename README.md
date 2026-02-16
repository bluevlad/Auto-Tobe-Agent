# Auto-Tobe-Agent

Autonomous Code Fixer Agent - QA Agent가 발견한 GitHub Issues를 자동으로 수정합니다.

## 개요

| 항목 | 내용 |
|------|------|
| **역할** | Code Fixer (코드 수정 전담) |
| **파트너** | [Autonomous-QA-Agent](https://github.com/bluevlad/Autonomous-QA-Agent) (이슈 발견 전담) |
| **계약** | GitHub Issues (QA-AGENT-META 구조화 메타데이터) |
| **첫 대상** | [hopenvision](https://github.com/bluevlad/hopenvision) (Java/Spring Boot + React) |

## 아키텍처

```
QA Inspector Agent                    Code Fixer Agent
(Autonomous-QA-Agent)                (Auto-Tobe-Agent)
"문제를 찾는다"                        "문제를 고친다"

 E2E/API 테스트                        Issue 파싱/분석
 소스코드 정적분석         GitHub       코드 수정
 의존성 취약점 스캔   ──── Issues ───→  fix 브랜치 생성
 Issue 자동 등록           (계약)       PR 생성
 수정 PR 검증         ←────────────── 검증 요청

 권한: READ-ONLY                      권한: READ + WRITE
```

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
npm start            # 에이전트 실행
```

## 프로젝트 구조

```
Auto-Tobe-Agent/
├── src/
│   ├── index.ts                    # 메인 엔트리포인트
│   ├── types/                      # TypeScript 타입 정의
│   ├── issue-parser.ts             # GitHub Issue 파싱
│   ├── project-resolver.ts         # 프로젝트 매핑
│   ├── fix-orchestrator.ts         # 수정 오케스트레이션
│   ├── pr-creator.ts               # PR 생성
│   └── verification-reporter.ts    # 검증 요청
├── configs/
│   ├── projects.json               # 대상 프로젝트 설정
│   └── approval-policy.json        # 승인 정책
├── strategies/                     # 카테고리별 수정 전략
├── templates/                      # 기술스택별 수정 패턴
└── docs/                           # 문서
```

## 현재 상태

**Phase 1: 프로젝트 기반 구축 (완료)**

- 타입 정의, 설정 파일, 디렉토리 구조 완성
- 상세 로드맵: [docs/PHASE_PLAN.md](docs/PHASE_PLAN.md)
- 아키텍처: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
