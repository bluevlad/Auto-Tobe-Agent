/**
 * 검증 리포터 (Verification Reporter)
 *
 * PR 생성 후, QA Agent의 원래 요청사항과 실제 수정 내용을 비교 분석하여
 * PR 코멘트로 적합성 리포트를 게시합니다.
 *
 * FIX_VERIFICATION_STANDARD 5단계 파이프라인과 연동:
 * - 1단계(우선순위): 정책 기반 검증 수준 결정
 * - 2단계(BUG 재현 테스트): [BUG-#N] 패턴 안내
 * - 3단계(연속 안정성): 필요 streak 정보 제공
 * - 4단계(PR 머지): PR 정보 연결
 * - 5단계(회귀 확인): 빌드/테스트 결과 포함
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type {
  ParsedIssue,
  FixResult,
  FixComplianceReport,
  FileCoverage,
  FixDirectionMatch,
  ComplianceScore,
  QaVerificationData,
  Priority,
} from './types/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * FIX_VERIFICATION_STANDARD 정책 매핑
 */
const VERIFICATION_POLICIES: Record<Priority, QaVerificationData> = {
  P0: {
    priority: 'P0',
    bugTestPattern: '[BUG-#N]',
    requiredConsecutivePasses: 3,
    requirePrMerged: true,
    requireNoRegression: true,
  },
  P1: {
    priority: 'P1',
    bugTestPattern: '[BUG-#N]',
    requiredConsecutivePasses: 3,
    requirePrMerged: true,
    requireNoRegression: true,
  },
  P2: {
    priority: 'P2',
    bugTestPattern: '[BUG-#N]',
    requiredConsecutivePasses: 2,
    requirePrMerged: true,
    requireNoRegression: true,
  },
  P3: {
    priority: 'P3',
    bugTestPattern: '[BUG-#N]',
    requiredConsecutivePasses: 1,
    requirePrMerged: false,
    requireNoRegression: false,
  },
};

/**
 * 파일 커버리지를 분석합니다.
 * QA Agent가 지적한 파일 중 실제 수정된 비율을 계산합니다.
 */
function analyzeFileCoverage(
  requestedFiles: string[],
  modifiedFiles: string[],
): FileCoverage {
  if (requestedFiles.length === 0) return 'full';

  const modifiedSet = new Set(modifiedFiles.map((f) => f.toLowerCase()));
  let matchCount = 0;

  for (const requested of requestedFiles) {
    const lower = requested.toLowerCase();
    // 정확히 일치하거나, 수정된 파일 경로의 일부로 포함되는 경우
    if (
      modifiedSet.has(lower) ||
      [...modifiedSet].some((m) => m.endsWith(lower) || lower.endsWith(m))
    ) {
      matchCount++;
    }
  }

  if (matchCount === requestedFiles.length) return 'full';
  if (matchCount > 0) return 'partial';
  return 'none';
}

/**
 * 수정 방향성을 분석합니다.
 * QA Agent의 권장 수정과 실제 변경 내용을 비교합니다.
 */
function analyzeFixDirection(
  issue: ParsedIssue,
  fixResult: FixResult,
): { match: FixDirectionMatch; analysis: string } {
  const recommendation = issue.parsedContent.recommendation ?? '';
  const fixHint = issue.meta?.fix_hint ?? '';
  const modifiedPaths = fixResult.modifiedFiles.map((f) => f.path);

  // 수정된 파일이 없으면 divergent
  if (modifiedPaths.length === 0) {
    return { match: 'divergent', analysis: '수정된 파일이 없습니다.' };
  }

  // fix_hint가 있으면 힌트 기반으로 판단
  if (fixHint) {
    const hintKeywords = fixHint.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const pathStr = modifiedPaths.join(' ').toLowerCase();
    const matchedKeywords = hintKeywords.filter((kw) => pathStr.includes(kw));
    const hintMatchRatio = hintKeywords.length > 0
      ? matchedKeywords.length / hintKeywords.length
      : 0;

    if (hintMatchRatio >= 0.5) {
      return {
        match: 'aligned',
        analysis: `fix_hint 키워드와 수정 파일이 일치합니다 (${matchedKeywords.length}/${hintKeywords.length} 매칭).`,
      };
    }
  }

  // 권장 수정 내용과 수정 파일 연관성 분석
  if (recommendation) {
    const recLower = recommendation.toLowerCase();
    const relatedFiles = modifiedPaths.filter((p) => {
      const parts = p.split('/');
      const filename = parts[parts.length - 1].toLowerCase();
      return recLower.includes(filename.replace(/\.\w+$/, ''));
    });

    if (relatedFiles.length > 0) {
      return {
        match: 'aligned',
        analysis: `권장 수정에서 언급된 파일이 수정되었습니다: ${relatedFiles.join(', ')}`,
      };
    }

    return {
      match: 'partial',
      analysis: '수정이 이루어졌으나 권장 수정과의 직접적 연관성을 정적 분석으로 확인하기 어렵습니다.',
    };
  }

  // 정보가 부족한 경우
  return {
    match: 'partial',
    analysis: `${modifiedPaths.length}개 파일이 수정되었습니다. QA Agent의 권장 수정 정보가 부족하여 정밀 비교가 제한됩니다.`,
  };
}

/**
 * fix_hint 준수 여부를 판단합니다.
 */
function analyzeFixHint(
  issue: ParsedIssue,
  fixResult: FixResult,
): { followed: boolean | null; note: string } {
  const hint = issue.meta?.fix_hint;
  if (!hint) {
    return { followed: null, note: 'QA-AGENT-META에 fix_hint가 없습니다.' };
  }

  const modifiedPaths = fixResult.modifiedFiles.map((f) => f.path.toLowerCase());
  const hintLower = hint.toLowerCase();

  // 힌트에 파일 경로가 포함된 경우 해당 파일이 수정되었는지 확인
  const pathPattern = /[\w\-/.]+\.(?:java|ts|tsx|js|jsx|py|yml|yaml|json|xml)/g;
  const hintFiles = [...hintLower.matchAll(pathPattern)].map((m) => m[0]);

  if (hintFiles.length > 0) {
    const matched = hintFiles.filter((hf) =>
      modifiedPaths.some((mp) => mp.includes(hf) || hf.includes(mp)),
    );
    if (matched.length === hintFiles.length) {
      return { followed: true, note: `fix_hint에 언급된 모든 파일이 수정됨: ${matched.join(', ')}` };
    }
    if (matched.length > 0) {
      return { followed: true, note: `fix_hint 파일 부분 매칭 (${matched.length}/${hintFiles.length})` };
    }
    return { followed: false, note: `fix_hint에 언급된 파일이 수정되지 않음: ${hintFiles.join(', ')}` };
  }

  // 키워드 기반 판단
  return { followed: null, note: `fix_hint 내용: "${hint}" (자동 판단 불가, 코드 리뷰 필요)` };
}

/**
 * 검증 기준 충족 추정
 */
function estimateVerificationCriteria(
  issue: ParsedIssue,
  fixResult: FixResult,
): { criteria: string | null; estimate: 'likely' | 'uncertain' | 'unlikely' } {
  const criteria = issue.meta?.verification ?? null;

  if (!criteria) {
    // 빌드/테스트 통과 여부로 추정
    const buildOk = fixResult.verifications.some((v) => v.type === 'build' && v.passed);
    const testOk = fixResult.verifications.some((v) => v.type === 'test' && v.passed);

    if (buildOk && testOk) return { criteria, estimate: 'likely' };
    if (buildOk || testOk) return { criteria, estimate: 'uncertain' };
    return { criteria, estimate: 'unlikely' };
  }

  // 검증 기준이 명시된 경우, 빌드/테스트 통과를 기본 조건으로 추정
  const allVerificationsPass = fixResult.verifications.every((v) => v.passed);
  if (allVerificationsPass && fixResult.modifiedFiles.length > 0) {
    return { criteria, estimate: 'likely' };
  }

  return { criteria, estimate: 'uncertain' };
}

/**
 * 종합 판정을 산출합니다.
 */
function calculateOverallScore(
  fileCoverage: FileCoverage,
  directionMatch: FixDirectionMatch,
  fixHintFollowed: boolean | null,
  criteriaEstimate: 'likely' | 'uncertain' | 'unlikely',
  buildPassed: boolean,
  testPassed: boolean,
): { score: ComplianceScore; summary: string } {
  // 빌드/테스트 실패 → rework_needed
  if (!buildPassed) {
    return { score: 'rework_needed', summary: '빌드가 실패하여 재작업이 필요합니다.' };
  }

  // 파일 커버리지 없음 + 방향 불일치 → rework_needed
  if (fileCoverage === 'none' && directionMatch === 'divergent') {
    return { score: 'rework_needed', summary: 'QA Agent가 지적한 파일이 수정되지 않고 방향성도 다릅니다.' };
  }

  // 완전 충족 → pass
  if (
    fileCoverage === 'full' &&
    directionMatch === 'aligned' &&
    (fixHintFollowed === true || fixHintFollowed === null) &&
    criteriaEstimate === 'likely' &&
    testPassed
  ) {
    return { score: 'pass', summary: 'QA Agent 요청사항과 수정 내용이 일치합니다. 검증 통과 가능성이 높습니다.' };
  }

  // fix_hint 미준수 → review_needed
  if (fixHintFollowed === false) {
    return { score: 'review_needed', summary: 'fix_hint에 언급된 파일이 수정되지 않아 리뷰가 필요합니다.' };
  }

  // 부분 일치 → review_needed
  return {
    score: 'review_needed',
    summary: '수정이 이루어졌으나 일부 항목에서 추가 검토가 필요합니다.',
  };
}

/**
 * 적합성 리포트를 생성합니다.
 */
export function generateComplianceReport(
  issue: ParsedIssue,
  fixResult: FixResult,
): FixComplianceReport {
  const requestedFiles = [
    ...(issue.meta?.files ?? []),
    ...(issue.parsedContent.affectedFiles ?? []),
  ];
  const uniqueRequestedFiles = [...new Set(requestedFiles)];
  const actuallyModified = fixResult.modifiedFiles.map((f) => f.path);

  const fileCoverage = analyzeFileCoverage(uniqueRequestedFiles, actuallyModified);
  const { match: fixDirectionMatch, analysis: directionAnalysis } =
    analyzeFixDirection(issue, fixResult);
  const { followed: fixHintFollowed, note: fixHintNote } =
    analyzeFixHint(issue, fixResult);
  const { criteria: verificationCriteria, estimate: criteriaMetEstimate } =
    estimateVerificationCriteria(issue, fixResult);

  const buildPassed = fixResult.verifications.some((v) => v.type === 'build' && v.passed);
  const testPassed = fixResult.verifications.some((v) => v.type === 'test' && v.passed);

  const { score: overallScore, summary } = calculateOverallScore(
    fileCoverage,
    fixDirectionMatch,
    fixHintFollowed,
    criteriaMetEstimate,
    buildPassed,
    testPassed,
  );

  return {
    issueNumber: fixResult.issueNumber,
    prNumber: fixResult.prNumber ?? 0,
    priority: fixResult.priority,
    requestedFiles: uniqueRequestedFiles,
    actuallyModified,
    fileCoverage,
    fixDirectionMatch,
    directionAnalysis,
    fixHintFollowed,
    fixHintNote,
    verificationCriteria,
    criteriaMetEstimate,
    buildPassed,
    testPassed,
    overallScore,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 적합성 리포트를 마크다운으로 변환합니다.
 */
function formatReportMarkdown(
  report: FixComplianceReport,
  qaVerification: QaVerificationData,
): string {
  const coverageIcon = report.fileCoverage === 'full' ? 'PASS'
    : report.fileCoverage === 'partial' ? 'WARN' : 'FAIL';
  const directionIcon = report.fixDirectionMatch === 'aligned' ? 'PASS'
    : report.fixDirectionMatch === 'partial' ? 'WARN' : 'FAIL';
  const hintIcon = report.fixHintFollowed === true ? 'PASS'
    : report.fixHintFollowed === false ? 'FAIL' : 'N/A';
  const criteriaIcon = report.criteriaMetEstimate === 'likely' ? 'PASS'
    : report.criteriaMetEstimate === 'uncertain' ? 'WARN' : 'FAIL';
  const buildIcon = report.buildPassed ? 'PASS' : 'FAIL';
  const testIcon = report.testPassed ? 'PASS' : 'FAIL';

  const scoreLabel = report.overallScore === 'pass' ? 'Pass'
    : report.overallScore === 'review_needed' ? 'Review Needed'
    : 'Rework Needed';

  const lines: string[] = [];
  lines.push('## Fix Compliance Report');
  lines.push('');
  lines.push(`> Auto-Tobe-Agent가 QA Agent의 요청사항 대비 수정 적합성을 분석한 리포트입니다.`);
  lines.push('');

  // 요약 테이블
  lines.push('| 항목 | 결과 |');
  lines.push('|------|------|');
  lines.push(`| 파일 커버리지 | [${coverageIcon}] ${report.fileCoverage} (${report.actuallyModified.length}/${report.requestedFiles.length} 파일) |`);
  lines.push(`| 수정 방향성 | [${directionIcon}] ${report.fixDirectionMatch} |`);
  lines.push(`| Fix Hint 반영 | [${hintIcon}] ${report.fixHintFollowed ?? 'N/A'} |`);
  lines.push(`| 검증 기준 충족 | [${criteriaIcon}] ${report.criteriaMetEstimate} |`);
  lines.push(`| 빌드 | [${buildIcon}] |`);
  lines.push(`| 테스트 | [${testIcon}] |`);
  lines.push(`| **종합 판정** | **${scoreLabel}** |`);
  lines.push('');

  // 분석 상세
  lines.push('### 분석');
  lines.push('');
  lines.push(`- **방향성**: ${report.directionAnalysis}`);
  lines.push(`- **Fix Hint**: ${report.fixHintNote}`);
  if (report.verificationCriteria) {
    lines.push(`- **검증 기준**: ${report.verificationCriteria}`);
  }
  lines.push(`- **판정**: ${report.summary}`);
  lines.push('');

  // 수정된 파일 목록
  if (report.actuallyModified.length > 0) {
    lines.push('### 수정된 파일');
    lines.push('');
    for (const f of report.actuallyModified) {
      const wasRequested = report.requestedFiles.some(
        (r) => r.toLowerCase() === f.toLowerCase() || f.toLowerCase().endsWith(r.toLowerCase()),
      );
      const tag = wasRequested ? '(QA 지적 파일)' : '(추가 수정)';
      lines.push(`- \`${f}\` ${tag}`);
    }
    lines.push('');
  }

  // QA Agent 검증 가이드 (FIX_VERIFICATION_STANDARD 연동)
  lines.push('### QA Agent 검증 가이드');
  lines.push('');
  lines.push(`| 검증 단계 | 요구사항 | 비고 |`);
  lines.push(`|-----------|---------|------|`);
  lines.push(`| 1. 우선순위 | ${report.priority} | |`);
  lines.push(`| 2. BUG 재현 테스트 | \`${qaVerification.bugTestPattern.replace('#N', `#${report.issueNumber}`)}\` 패턴 테스트 | ${['P0', 'P1'].includes(report.priority) ? '필수' : '선택'} |`);
  lines.push(`| 3. 연속 안정성 | ${qaVerification.requiredConsecutivePasses}회 연속 통과 필요 | |`);
  lines.push(`| 4. PR 머지 확인 | ${qaVerification.requirePrMerged ? '필수' : '선택'} | |`);
  lines.push(`| 5. 회귀 확인 | ${qaVerification.requireNoRegression ? '필수' : '선택'} | |`);
  lines.push('');

  lines.push('---');
  lines.push('Auto-generated by [Auto-Tobe-Agent](https://github.com/bluevlad/Auto-Tobe-Agent) Verification Reporter');

  return lines.join('\n');
}

/**
 * PR에 적합성 리포트 코멘트를 게시합니다.
 */
async function postPrComment(
  repo: string,
  prNumber: number,
  body: string,
  cwd: string,
): Promise<void> {
  const escapedBody = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  await execAsync(
    `gh pr comment ${prNumber} --repo ${repo} --body "${escapedBody}"`,
    { cwd, timeout: 30_000 },
  );
}

/**
 * PR에 라벨을 추가합니다.
 */
async function addPrLabel(
  repo: string,
  prNumber: number,
  label: string,
  cwd: string,
): Promise<void> {
  try {
    await execAsync(
      `gh pr edit ${prNumber} --repo ${repo} --add-label "${label}"`,
      { cwd, timeout: 15_000 },
    );
  } catch {
    // 라벨이 존재하지 않는 경우 무시
  }
}

/**
 * 프로젝트의 로컬 경로를 가져옵니다.
 */
function getProjectCwd(project: string): string {
  const configPath = resolve(__dirname, '..', 'configs', 'projects.json');
  let content = readFileSync(configPath, 'utf-8');
  content = content.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  const config = JSON.parse(content);
  return config.projects[project]?.local_path ?? process.cwd();
}

/**
 * 수정 적합성 검증을 실행하고 PR에 리포트를 게시합니다.
 *
 * 흐름: 리포트 생성 → 마크다운 포맷 → PR 코멘트 → 라벨 추가
 */
export async function requestVerification(
  issue: ParsedIssue,
  fixResult: FixResult,
): Promise<FixResult> {
  const updated = { ...fixResult };

  if (!fixResult.prNumber || !fixResult.prUrl) {
    console.log('  [verify] SKIP: PR 정보 없음');
    return updated;
  }

  console.log(`  [verify] #${fixResult.issueNumber} 적합성 리포트 생성 중...`);

  try {
    // 1. 적합성 리포트 생성
    const report = generateComplianceReport(issue, fixResult);
    report.prNumber = fixResult.prNumber;

    // 2. QA 검증 정책 매핑
    const qaVerification = VERIFICATION_POLICIES[fixResult.priority];

    // 3. 마크다운 포맷
    const markdown = formatReportMarkdown(report, qaVerification);

    // 4. PR 코멘트 게시
    const cwd = getProjectCwd(fixResult.project);
    await postPrComment(fixResult.repo, fixResult.prNumber, markdown, cwd);
    console.log(`  [verify] PR #${fixResult.prNumber}에 리포트 게시 완료`);

    // 5. 판정에 따른 라벨 추가
    const labelMap: Record<string, string> = {
      pass: 'verification-ready',
      review_needed: 'needs-review',
      rework_needed: 'needs-rework',
    };
    const label = labelMap[report.overallScore];
    if (label) {
      await addPrLabel(fixResult.repo, fixResult.prNumber, label, cwd);
      console.log(`  [verify] 라벨 추가: ${label}`);
    }

    // 6. 상태 업데이트
    updated.status = 'verification_requested';
    console.log(`  [verify] 종합 판정: ${report.overallScore} - ${report.summary}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(`  [verify] 리포트 게시 실패: ${errMsg}`);
    // 검증 리포트 실패는 전체 프로세스를 중단하지 않음
  }

  return updated;
}

/**
 * 검증 성공 시 이슈를 종료합니다.
 * QA Agent의 검증 파이프라인이 pass 판정 후 호출됩니다.
 */
export async function closeIssueOnSuccess(
  fixResult: FixResult,
): Promise<void> {
  if (!fixResult.prNumber) {
    console.log('  [close] SKIP: PR 정보 없음');
    return;
  }

  const cwd = getProjectCwd(fixResult.project);

  try {
    await execAsync(
      `gh issue close ${fixResult.issueNumber} --repo ${fixResult.repo} --comment "PR #${fixResult.prNumber}에서 수정 완료. Auto-Tobe-Agent 검증 리포트 통과."`,
      { cwd, timeout: 15_000 },
    );
    console.log(`  [close] Issue #${fixResult.issueNumber} 종료 완료`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(`  [close] Issue 종료 실패: ${errMsg}`);
  }
}

// export for testing
export { formatReportMarkdown, VERIFICATION_POLICIES };
