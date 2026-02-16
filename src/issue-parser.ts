import type { ParsedIssue, IssueParseError } from './types/index.js';

/**
 * GitHub Issue에서 구조화된 이슈 데이터를 파싱합니다.
 * QA-AGENT-META 메타데이터가 있으면 추출, 없으면 본문 텍스트 파싱.
 *
 * @param issueNumber - GitHub Issue 번호
 * @param repo - 대상 리포지토리 (owner/repo)
 * @returns ParsedIssue 또는 IssueParseError
 */
export async function parseIssue(
  issueNumber: number,
  repo: string,
): Promise<ParsedIssue | IssueParseError> {
  // Phase 2에서 구현
  throw new Error(`Not implemented - Phase 2 (issue #${issueNumber}, repo: ${repo})`);
}

/**
 * 여러 이슈를 일괄 파싱합니다.
 *
 * @param issueNumbers - GitHub Issue 번호 목록
 * @param repo - 대상 리포지토리 (owner/repo)
 * @returns 파싱 결과 배열
 */
export async function parseIssues(
  issueNumbers: number[],
  repo: string,
): Promise<Array<ParsedIssue | IssueParseError>> {
  // Phase 2에서 구현
  throw new Error(`Not implemented - Phase 2 (${issueNumbers.length} issues, repo: ${repo})`);
}
