/**
 * Triage Labeler — 자동 수정 불가 이슈를 사람이 볼 수 있게 표시
 *
 * determineAutoFixable=false 로 분류된 이슈는 배치에서 조용히 건너뛰어져
 * 아무도 모르게 방치됐다 (NewsLetterPlatform #4·#9~#29, 최대 8개월).
 * 1회만 `needs-triage` 라벨 + 사유 코멘트를 남겨 사람의 판단 대기열로 넘긴다.
 * 라벨이 이미 있으면 아무것도 하지 않으므로 매 배치 재실행해도 안전하다.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import type { ParsedIssue } from './types/issue.js';

const execFileAsync = promisify(execFile);

export const NEEDS_TRIAGE_LABEL = 'needs-triage';

function buildTriageComment(issue: ParsedIssue): string {
  return [
    '### Auto-Tobe-Agent: 자동 수정 대상에서 제외됨',
    '',
    `이 이슈(${issue.priority} / ${issue.category})는 자동 수정 불가로 분류되어 수정 배치에서 건너뜁니다.`,
    '',
    '주요 사유 (issue-parser `determineAutoFixable`):',
    '- QA-AGENT-META 가 `auto_fixable: false` 로 지정',
    '- `improvement` 개선 제안 이슈인데 QA-AGENT-META 가 없음 (구체 수정 정보 부재)',
    '- 10회 이상 연속 실패 (환경·인프라 문제로 추정)',
    '- P0 보안 이슈',
    '',
    '**사람의 판단이 필요합니다**: 직접 수정, 이미 해결됐다면 close, 자동 처리를 원하면 QA-AGENT-META 보강 후 이 라벨 제거.',
    '',
    '_Auto-Tobe-Agent 가 자동으로 남긴 코멘트입니다 (이슈당 1회)._',
  ].join('\n');
}

async function addLabel(repo: string, issueNumber: number): Promise<void> {
  const args = ['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', NEEDS_TRIAGE_LABEL];
  try {
    await execFileAsync('gh', args, { timeout: 15_000 });
  } catch {
    // 라벨 미존재 시 생성 후 1회 재시도
    await execFileAsync('gh', [
      'label', 'create', NEEDS_TRIAGE_LABEL, '--repo', repo, '--force',
      '--color', 'FBCA04', '--description', '자동 수정 불가 — 사람의 분류 필요',
    ], { timeout: 15_000 });
    await execFileAsync('gh', args, { timeout: 15_000 });
  }
}

/**
 * 자동 수정 불가 이슈에 needs-triage 라벨 + 사유 코멘트를 남깁니다 (이슈당 1회).
 *
 * @returns 이번 호출에서 새로 표시했으면 true
 */
export async function markNeedsTriage(issue: ParsedIssue): Promise<boolean> {
  if (issue.isAutoFixable || issue.labels.includes(NEEDS_TRIAGE_LABEL)) return false;

  try {
    await addLabel(issue.repo, issue.number);
    await execFileAsync('gh', [
      'issue', 'comment', String(issue.number), '--repo', issue.repo,
      '--body', buildTriageComment(issue),
    ], { timeout: 15_000 });
    return true;
  } catch (err) {
    console.warn(
      `  [triage] ${issue.repo}#${issue.number} 표시 실패: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
