/**
 * Issue Correlator (Phase 8)
 *
 * Docker 모니터링에서 감지된 이슈를 분석하여:
 * - 기존 GitHub Issue와 매핑 (중복 방지)
 * - 심각도 → 우선순위 변환
 * - 코드 수정 필요 여부 판단
 * - 인프라/코드 이슈 분류
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type {
  DockerIssue,
  DockerIssueSeverity,
  Priority,
  IssueCategory,
  ParsedIssue,
  MonitorResult,
} from './types/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 이슈 상관관계 결과 */
export interface CorrelationResult {
  /** 원본 Docker 이슈 */
  dockerIssue: DockerIssue;
  /** 매핑된 기존 GitHub Issue 번호 (있으면) */
  existingIssueNumber?: number;
  /** 중복 여부 */
  isDuplicate: boolean;
  /** GitHub Issue 생성 필요 여부 */
  needsGitHubIssue: boolean;
  /** 코드 수정 필요 여부 */
  needsCodeFix: boolean;
  /** 변환된 우선순위 */
  priority: Priority;
  /** 변환된 카테고리 */
  category: IssueCategory;
  /** 권장 조치 설명 */
  actionDescription: string;
}

/** 일괄 상관관계 분석 결과 */
export interface BatchCorrelationResult {
  timestamp: string;
  total: number;
  duplicates: number;
  newIssues: number;
  codeFixNeeded: number;
  infraOnly: number;
  results: CorrelationResult[];
}

// ===== Severity → Priority 매핑 =====

function severityToPriority(severity: DockerIssueSeverity, issueType: DockerIssue['type']): Priority {
  if (severity === 'critical') {
    // container_stopped, health_check_failed → P0
    if (issueType === 'container_stopped' || issueType === 'health_check_failed') {
      return 'P0';
    }
    // resource_exceeded, log_anomaly critical → P1
    return 'P1';
  }

  if (severity === 'warning') {
    // 리소스 초과 경고 → P2
    if (issueType === 'resource_exceeded') return 'P2';
    // 로그 이상 경고 → P2
    if (issueType === 'log_anomaly') return 'P2';
    // 컨테이너 재시작 경고 → P2
    if (issueType === 'container_restart') return 'P2';
    return 'P3';
  }

  return 'P3';
}

// ===== Issue Type → Category 매핑 =====

function issueTypeToCategory(issue: DockerIssue): IssueCategory {
  switch (issue.type) {
    case 'health_check_failed':
    case 'container_stopped':
    case 'container_restart':
      return 'operations';
    case 'resource_exceeded':
      return 'performance';
    case 'log_anomaly':
      // 로그 패턴으로 세분화
      if (issue.matchedLogs?.some((l) => /security|auth|permission|denied/i.test(l))) {
        return 'security';
      }
      if (issue.matchedLogs?.some((l) => /slow|timeout|latency|performance/i.test(l))) {
        return 'performance';
      }
      if (issue.matchedLogs?.some((l) => /OutOfMemory|StackOverflow|NullPointer/i.test(l))) {
        return 'code-quality';
      }
      return 'operations';
    default:
      return 'operations';
  }
}

// ===== 코드 수정 필요 여부 판단 =====

function needsCodeFix(issue: DockerIssue): boolean {
  // 인프라 문제 (재시작으로 해결 가능)
  if (issue.type === 'container_stopped') return false;
  if (issue.type === 'health_check_failed' && issue.severity !== 'critical') return false;

  // 리소스 문제 → 코드 최적화 가능
  if (issue.type === 'resource_exceeded') return true;

  // 반복 재시작 → 코드 버그 가능성
  if (issue.type === 'container_restart') return true;

  // 로그 이상 → 코드 수정 필요
  if (issue.type === 'log_anomaly') {
    // critical 로그 패턴은 코드 수정 필요
    if (issue.severity === 'critical') return true;
    // warning은 선택적
    return false;
  }

  return false;
}

// ===== GitHub Issue 중복 검사 =====

/**
 * 기존 Open GitHub Issue 중 유사한 이슈가 있는지 확인합니다.
 */
async function findExistingIssue(
  repo: string,
  dockerIssue: DockerIssue,
): Promise<number | undefined> {
  try {
    // 컨테이너명 + 이슈 타입으로 검색
    const searchTerm = `${dockerIssue.containerName} ${dockerIssue.type.replace(/_/g, ' ')}`;
    const { stdout } = await execAsync(
      `gh issue list --repo ${repo} --state open --search "${searchTerm}" --json number,title --limit 5`,
      { timeout: 15_000 },
    );

    const issues = JSON.parse(stdout) as { number: number; title: string }[];

    // 제목에 컨테이너명과 이슈 타입이 모두 포함된 이슈 찾기
    for (const issue of issues) {
      const titleLower = issue.title.toLowerCase();
      const containerLower = dockerIssue.containerName.toLowerCase();
      const typeParts = dockerIssue.type.split('_');

      if (
        titleLower.includes(containerLower) ||
        (typeParts.every((part) => titleLower.includes(part)) &&
          titleLower.includes(dockerIssue.service))
      ) {
        return issue.number;
      }
    }

    // docker-ops 라벨로 더 넓게 검색
    const { stdout: labelSearch } = await execAsync(
      `gh issue list --repo ${repo} --state open --label "docker-ops" --json number,title --limit 20`,
      { timeout: 15_000 },
    );

    const labelIssues = JSON.parse(labelSearch) as { number: number; title: string }[];
    for (const issue of labelIssues) {
      if (issue.title.includes(dockerIssue.containerName) ||
          issue.title.includes(dockerIssue.service)) {
        return issue.number;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ===== 조치 설명 생성 =====

function buildActionDescription(issue: DockerIssue, isCodeFix: boolean): string {
  const actions: string[] = [];

  switch (issue.suggestedAction) {
    case 'restart':
      actions.push('컨테이너 재시작');
      break;
    case 'scale':
      actions.push('리소스 확장 또는 최적화');
      break;
    case 'code_fix':
      actions.push('소스 코드 수정');
      break;
    case 'config_change':
      actions.push('설정 변경');
      break;
    case 'manual':
      actions.push('수동 확인 필요');
      break;
    default:
      actions.push('조치 불필요');
  }

  if (isCodeFix) {
    actions.push('Auto-Tobe-Agent를 통한 자동 코드 수정 대상');
  }

  return actions.join(' → ');
}

// ===== GitHub Issue 본문 생성 =====

/**
 * Docker 이슈를 GitHub Issue 본문으로 변환합니다.
 */
export function buildDockerIssueBody(
  issue: DockerIssue,
  priority: Priority,
  category: IssueCategory,
): { title: string; body: string; labels: string[] } {
  const typeLabel = issue.type.replace(/_/g, ' ');
  const title = `[${priority}][${category}] Docker ${typeLabel}: ${issue.service} (${issue.containerName})`;

  const lines: string[] = [];
  lines.push(`## Docker 서비스 이슈`);
  lines.push('');
  lines.push(`| 항목 | 값 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 프로젝트 | ${issue.project} |`);
  lines.push(`| 서비스 | ${issue.service} |`);
  lines.push(`| 컨테이너 | ${issue.containerName} |`);
  lines.push(`| 유형 | ${typeLabel} |`);
  lines.push(`| 심각도 | ${issue.severity} |`);
  lines.push(`| 감지 시각 | ${issue.timestamp} |`);
  lines.push('');
  lines.push(`## 상세 내용`);
  lines.push('');
  lines.push(issue.details);
  lines.push('');

  if (issue.matchedLogs && issue.matchedLogs.length > 0) {
    lines.push(`## 매칭된 로그`);
    lines.push('');
    lines.push('```');
    for (const log of issue.matchedLogs) {
      lines.push(log);
    }
    lines.push('```');
    lines.push('');
  }

  if (issue.resourceSnapshot) {
    lines.push(`## 리소스 스냅샷`);
    lines.push('');
    lines.push(`| 지표 | 값 |`);
    lines.push(`|------|-----|`);
    lines.push(`| CPU | ${issue.resourceSnapshot.cpuPercent.toFixed(1)}% |`);
    lines.push(`| Memory | ${issue.resourceSnapshot.memoryUsageMb.toFixed(0)}MB / ${issue.resourceSnapshot.memoryLimitMb.toFixed(0)}MB (${issue.resourceSnapshot.memoryPercent.toFixed(1)}%) |`);
    lines.push(`| Network I/O | ${issue.resourceSnapshot.networkRx} / ${issue.resourceSnapshot.networkTx} |`);
    lines.push('');
  }

  lines.push(`## 권장 조치`);
  lines.push('');
  lines.push(`- ${issue.suggestedAction}`);
  lines.push('');

  lines.push(`<!-- QA-AGENT-META`);
  lines.push(JSON.stringify({
    project: issue.project,
    repo: '',
    priority,
    category,
    files: [],
    auto_fixable: needsCodeFix(issue),
    fix_hint: `Docker ${typeLabel} for ${issue.service}`,
    verification: `docker ps 및 health check로 확인`,
  }, null, 2));
  lines.push(`-->`);

  const labels = [
    priority.toLowerCase(),
    category,
    'docker-ops',
    `severity-${issue.severity}`,
  ];

  return { title: title.substring(0, 100), body: lines.join('\n'), labels };
}

// ===== Main Correlation Logic =====

/**
 * 단일 Docker 이슈를 분석합니다.
 */
async function correlateIssue(
  dockerIssue: DockerIssue,
  repo: string,
): Promise<CorrelationResult> {
  const priority = severityToPriority(dockerIssue.severity, dockerIssue.type);
  const category = issueTypeToCategory(dockerIssue);
  const isCodeFix = needsCodeFix(dockerIssue);
  const existingIssueNumber = await findExistingIssue(repo, dockerIssue);
  const isDuplicate = existingIssueNumber !== undefined;
  const needsGitHubIssue = !isDuplicate && (dockerIssue.severity !== 'info');

  return {
    dockerIssue,
    existingIssueNumber,
    isDuplicate,
    needsGitHubIssue,
    needsCodeFix: isCodeFix,
    priority,
    category,
    actionDescription: buildActionDescription(dockerIssue, isCodeFix),
  };
}

/**
 * 모니터링 결과의 모든 이슈를 일괄 분석합니다.
 */
export async function correlateMonitorResult(
  monitorResult: MonitorResult,
  projectRepoMap: Record<string, string>,
): Promise<BatchCorrelationResult> {
  const results: CorrelationResult[] = [];

  for (const issue of monitorResult.issues) {
    const repo = projectRepoMap[issue.project];
    if (!repo) {
      console.log(`  [correlate] ${issue.project}: repo 매핑 없음, 건너뜀`);
      continue;
    }

    const result = await correlateIssue(issue, repo);
    results.push(result);

    const status = result.isDuplicate
      ? `DUPLICATE (#${result.existingIssueNumber})`
      : result.needsGitHubIssue
        ? 'NEW ISSUE'
        : 'SKIP';

    console.log(`  [correlate] ${issue.service} ${issue.type}: ${status} [${result.priority}]`);
  }

  const batchResult: BatchCorrelationResult = {
    timestamp: new Date().toISOString(),
    total: results.length,
    duplicates: results.filter((r) => r.isDuplicate).length,
    newIssues: results.filter((r) => r.needsGitHubIssue).length,
    codeFixNeeded: results.filter((r) => r.needsCodeFix).length,
    infraOnly: results.filter((r) => !r.needsCodeFix).length,
    results,
  };

  console.log('\n[correlate] Summary:');
  console.log(`  Total: ${batchResult.total}`);
  console.log(`  Duplicates: ${batchResult.duplicates}`);
  console.log(`  New issues: ${batchResult.newIssues}`);
  console.log(`  Code fix needed: ${batchResult.codeFixNeeded}`);

  return batchResult;
}

/**
 * 새로 감지된 이슈를 GitHub Issue로 생성합니다.
 */
export async function createDockerGitHubIssues(
  correlationResults: CorrelationResult[],
  projectRepoMap: Record<string, string>,
): Promise<{ created: number; errors: number }> {
  let created = 0;
  let errors = 0;

  const newIssues = correlationResults.filter((r) => r.needsGitHubIssue);

  for (const result of newIssues) {
    const repo = projectRepoMap[result.dockerIssue.project];
    if (!repo) continue;

    const { title, body, labels } = buildDockerIssueBody(
      result.dockerIssue,
      result.priority,
      result.category,
    );

    try {
      const labelArgs = labels.map((l) => `--label "${l}"`).join(' ');
      const escapedTitle = title.replace(/"/g, '\\"');
      const { stdout } = await execAsync(
        `gh issue create --repo ${repo} --title "${escapedTitle}" ${labelArgs} --body "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
        { timeout: 30_000 },
      );
      console.log(`  [create] Issue created: ${stdout.trim()}`);
      created++;
    } catch (error) {
      const err = error as { message?: string };
      console.log(`  [create] Failed: ${err.message?.substring(0, 100)}`);
      errors++;
    }
  }

  return { created, errors };
}

export {
  severityToPriority,
  issueTypeToCategory,
  needsCodeFix,
  findExistingIssue,
};
