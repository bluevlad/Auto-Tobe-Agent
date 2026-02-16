import type { ParsedIssue, ResolvedProject, FixResult } from './types/index.js';

/**
 * 이슈 수정 워크플로우를 오케스트레이션합니다.
 * 브랜치 생성 -> 코드 수정 -> 빌드/테스트 검증
 *
 * @param issue - 파싱된 이슈
 * @param project - 해석된 프로젝트 설정
 * @returns FixResult
 */
export async function orchestrateFix(
  issue: ParsedIssue,
  project: ResolvedProject,
): Promise<FixResult> {
  // Phase 3에서 구현
  throw new Error(
    `Not implemented - Phase 3 (issue #${issue.number}, project: ${project.name})`,
  );
}

/**
 * 여러 이슈를 우선순위 순서대로 수정합니다.
 *
 * @param issues - 파싱된 이슈 목록 (우선순위 정렬됨)
 * @param project - 해석된 프로젝트 설정
 * @returns 개별 수정 결과 배열
 */
export async function orchestrateBatchFix(
  issues: ParsedIssue[],
  project: ResolvedProject,
): Promise<FixResult[]> {
  // Phase 3에서 구현
  throw new Error(
    `Not implemented - Phase 3 (${issues.length} issues, project: ${project.name})`,
  );
}
