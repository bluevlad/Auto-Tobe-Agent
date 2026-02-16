import type { FixResult } from './types/index.js';

/**
 * 수정 결과를 기반으로 PR을 생성합니다.
 * COMMIT_CONVENTION과 BRANCH_CONVENTION을 준수합니다.
 *
 * @param fixResult - 수정 결과
 * @returns PR URL이 포함된 업데이트된 FixResult
 */
export async function createPullRequest(
  fixResult: FixResult,
): Promise<FixResult> {
  // Phase 3에서 구현
  throw new Error(
    `Not implemented - Phase 3 (issue #${fixResult.issueNumber})`,
  );
}
