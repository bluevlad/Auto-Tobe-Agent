# PR-first 전략 및 Phase 1 운영 가이드

> 작성: 2026-03-23
> 커밋: f29fa1a
> 관련 제안: [AUTO_TOBE_AGENT_PROPOSAL.md](https://github.com/bluevlad/Claude-Opus-bluevlad/blob/main/services/hopenvision/dev/AUTO_TOBE_AGENT_PROPOSAL.md)

---

## 1. 개요

Phase 1은 Auto-Tobe-Agent의 **즉시 해결** 항목 3건으로, 현재 100% 실패 중인 hopenvision 수정 파이프라인을 복구하는 것이 목표입니다.

| # | 항목 | 효과 |
|---|------|------|
| 1 | PR-first 전략 | 빌드 실패해도 PR 생성 → CI에 검증 위임 |
| 2 | 중복 이슈 필터링 | 동일 테스트 실패의 ~30개 중복 이슈 방지 |
| 3 | projects.local.json | MacBook/서버 등 환경별 경로 분리 |

---

## 2. PR-first 전략

### 문제

MacBook에서 `./gradlew build` 실행 시 gradlew 파일이 없거나 Java 환경 미설정으로 100% 빌드 실패 → 수정 파일이 있어도 PR이 생성되지 않음.

### 해결

빌드 실패 시 새로운 상태 `build_failed_ci_pending`으로 전환하여 PR을 생성하고, GitHub Actions CI에 빌드 검증을 위임합니다.

```
Claude Code CLI → 코드 수정
                    ↓
              빌드 실행
          ┌───────┴───────┐
        성공             실패
          ↓               ↓
    build_verified    build_failed_ci_pending
          ↓               ↓
       PR 생성         PR 생성 (CI 위임)
                        + needs-ci-verification 라벨
                        + 로컬 빌드 에러 상세 포함
```

### 변경 파일

| 파일 | 변경 |
|------|------|
| `src/types/fix-result.ts` | `FixStatus`에 `build_failed_ci_pending` 추가 |
| `src/fix-orchestrator.ts` | 빌드 실패 시 커밋 → `build_failed_ci_pending` 반환 |
| `src/pr-creator.ts` | `build_failed_ci_pending` 허용, `needs-ci-verification` 라벨 |
| `src/fix-history.ts` | 성공 상태 목록에 `build_failed_ci_pending` 추가 |

### PR 본문 예시

PR-first로 생성된 PR에는 아래 섹션이 추가됩니다:

```markdown
## :warning: CI Verification Required

로컬 빌드가 실패하여 **PR-first 전략**으로 PR을 생성했습니다.
GitHub Actions CI에서 빌드/테스트 결과를 확인해주세요.

<details><summary>로컬 빌드 에러</summary>
./gradlew: No such file or directory
</details>
```

### Frontend-only 빌드 분기

수정 파일이 모두 `web-admin/` 하위인 경우, `./gradlew build` 대신 `npm run build`만 실행합니다.

```
수정 파일 판별:
  web-admin/src/App.tsx        → Frontend-only ✓
  web-admin/src/api/client.ts  → Frontend-only ✓
  api/src/main/java/...        → Backend 포함 → gradlew build

Frontend-only: npm run build (web-admin/)
Backend 포함:  ./gradlew build (api/) → 실패 시 PR-first 적용
```

---

## 3. 중복 이슈 필터링

### 문제

QA Agent가 동일 테스트 실패를 매번 새 이슈로 생성 (제목에 실패 횟수/날짜 포함):
- `[P2][Frontend] 정답 입력 페이지 렌더링 실패 (3회 연속)`
- `[P2][Frontend] 정답 입력 페이지 렌더링 실패 (4회 연속)`
- → 이슈 번호가 달라서 별개 이슈로 처리됨

### 해결

`extractDeduplicationKey()` 함수로 제목에서 변동 부분을 제거하여 동일 테스트를 식별합니다.

```typescript
// 입력 → 출력 예시
"[P2][Frontend] 정답 입력 페이지 렌더링 실패 (3회 연속)"
  → "정답 입력 페이지 렌더링 실패"

"[P3][CodeQuality] exam-list 테이블 셀렉터 오류 (2026-03-17)"
  → "exam-list 테이블 셀렉터 오류"
```

### 제거 패턴

| 패턴 | 예시 |
|------|------|
| `[P0][Category]` 접두사 | `[P2][Frontend] ` |
| 실패 횟수 | `(3회 연속)`, `(N회)`, `(연속 5회 실패)` |
| 날짜 | `(2026-03-17)`, `(03/17)` |
| 이슈 번호 접미사 | `#88` |

### 변경 파일

| 파일 | 변경 |
|------|------|
| `src/issue-parser.ts` | `extractDeduplicationKey()` 함수 추가 |
| `src/fix-history.ts` | `isDuplicateByKey()` 함수, `FixHistoryEntry.deduplicationKey` 필드 |
| `src/fix-orchestrator.ts` | 수정 시 `deduplicationKey` 생성 및 결과에 저장 |
| `src/types/fix-result.ts` | `FixResult.deduplicationKey` 필드 |

### 사용법

```typescript
import { extractDeduplicationKey } from './issue-parser.js';
import { isDuplicateByKey, loadHistory } from './fix-history.js';

const history = loadHistory();
const key = extractDeduplicationKey(issue.title);
const { isDuplicate, existingIssueNumber } = isDuplicateByKey(history, 'hopenvision', key);

if (isDuplicate) {
  console.log(`중복 이슈: #${issue.number} ← 기존 #${existingIssueNumber}`);
  // skip 처리
}
```

---

## 4. projects.local.json 환경 오버라이드

### 문제

`configs/projects.json`의 `local_path`가 `${HOME}/GIT/hopenvision`으로 되어 있지만, MacBook에서 실제 경로가 다르거나 빌드 옵션을 변경해야 하는 경우 git-tracked 파일을 수정해야 함.

### 해결

`configs/projects.local.json` 파일로 환경별 오버라이드 지원. `.gitignore`에 이미 `configs/*.local.json`이 포함되어 있어 보안 정보 유출 방지.

### 설정 방법

```bash
# 예제 파일 복사
cp configs/projects.local.json.example configs/projects.local.json

# 환경에 맞게 수정
```

### 파일 형식

```json
{
  "projects": {
    "hopenvision": {
      "local_path": "/Users/rainend/GIT/hopenvision",
      "commands": {
        "build_backend": "./gradlew build -x test",
        "build_backend_cwd": "api/"
      },
      "urls": {
        "backend": "http://172.30.1.72:9050"
      }
    }
  }
}
```

### Merge 규칙

- **1-depth shallow merge**: `commands`, `urls` 등 중첩 객체는 필드 단위로 머지 (전체 교체가 아님)
- **projects wrapper 지원**: `{ "projects": { ... } }` 또는 직접 `{ "hopenvision": { ... } }` 둘 다 가능
- **`_comment` 필드 무시**: 메타 설명용 필드는 자동 제거
- **환경변수 치환**: `${HOME}`, `${USER}` 등 사용 가능

### 변경 파일

| 파일 | 변경 |
|------|------|
| `src/project-resolver.ts` | `mergeLocalOverrides()` 함수, `loadProjectsConfig()`에서 로드 |

---

## 5. 동작 확인

### 타입 체크

```bash
npm run type-check   # tsc --noEmit (에러 없으면 성공)
```

### 빌드

```bash
npm run build        # tsc (dist/ 생성)
```

### 테스트 실행 (수동)

```bash
# 단일 이슈 수정 (PR-first 적용됨)
npm start -- fix hopenvision 88

# 프로젝트 설정 확인 (local 오버라이드 반영됨)
npm start -- resolve hopenvision

# Pre-flight 검증
npm start -- preflight hopenvision
```

---

## 6. 다음 단계 (Phase 1 → Phase 2)

Phase 1 완료 후, hopenvision Phase 1~2 merge를 대기하며 아래 항목 진행:

| # | 항목 | 파일 | 설명 |
|---|------|------|------|
| 4 | fix_hint 프롬프트 주입 | `fix-orchestrator.ts` | QA-AGENT-META.fix_hint → Claude Code CLI |
| 5 | Frontend-only 빌드 분기 | `fix-orchestrator.ts` | (이번에 함께 구현 완료) |
| 6 | 수정 범위 제한 | `projects.json` | hopenvision 패키지 경계 인식 |

상세: [AUTO_TOBE_AGENT_PROPOSAL.md §6](https://github.com/bluevlad/Claude-Opus-bluevlad/blob/main/services/hopenvision/dev/AUTO_TOBE_AGENT_PROPOSAL.md#6-구현-로드맵)
