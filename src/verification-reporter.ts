import type { FixResult } from './types/index.js';

/**
 * Inspector(QA Agent)에게 검증을 요청하고 결과를 수집합니다.
 * QA Agent의 E2E/API 테스트를 트리거하여 수정 결과를 검증합니다.
 *
 * @param fixResult - PR이 생성된 수정 결과
 * @returns 검증 결과가 업데이트된 FixResult
 */
export async function requestVerification(
  fixResult: FixResult,
): Promise<FixResult> {
  // Phase 4에서 구현
  throw new Error(
    `Not implemented - Phase 4 (issue #${fixResult.issueNumber}, PR #${fixResult.prNumber})`,
  );
}

/**
 * 검증 결과에 따라 이슈를 종료합니다.
 *
 * @param fixResult - 검증이 완료된 수정 결과
 */
export async function closeIssueOnSuccess(
  fixResult: FixResult,
): Promise<void> {
  // Phase 4에서 구현
  throw new Error(
    `Not implemented - Phase 4 (issue #${fixResult.issueNumber})`,
  );
}
