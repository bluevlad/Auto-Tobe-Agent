/**
 * Auto-Tobe-Agent - Autonomous Code Fixer
 *
 * QA Agent가 발견한 GitHub Issues를 자동으로 수정하는 Agent
 *
 * 사용법:
 *   npm start                              # 설정 로드 및 상태 표시
 *   npm start -- scan <project>            # 이슈 스캔 및 파싱
 *   npm start -- resolve <project>         # 프로젝트 상태 확인
 *   npm start -- fix <project> <issue#>    # 단일 이슈 수정
 *   npm start -- fix <project> --auto      # 자동 수정 가능한 이슈 일괄 수정
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { ProjectsConfig, ApprovalPolicyConfig, Priority, ParsedIssue, BatchFixResult } from './types/index.js';
import { fetchOpenIssueNumbers, parseIssue, isParsedIssue, sortByPriority } from './issue-parser.js';
import { resolveProject, resolveAllProjects } from './project-resolver.js';
import { orchestrateFix, orchestrateBatchFix } from './fix-orchestrator.js';
import { createPullRequest } from './pr-creator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, '..', relativePath);
  const content = readFileSync(fullPath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * 기본 모드: 설정 로드 및 상태 표시
 */
function showStatus(): void {
  console.log('Auto-Tobe-Agent v0.3.0');
  console.log('='.repeat(50));

  const projects = loadConfig<ProjectsConfig>('configs/projects.json');
  console.log(`Projects config v${projects.version} loaded`);

  const enabledProjects = Object.entries(projects.projects)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name);
  console.log(`Enabled projects: ${enabledProjects.join(', ')}`);

  const policy = loadConfig<ApprovalPolicyConfig>('configs/approval-policy.json');
  console.log(`Approval policy v${policy.version} loaded`);
  console.log(`Default reviewers: ${policy.default_reviewers.join(', ')}`);

  console.log('='.repeat(50));
  console.log('\nCommands:');
  console.log('  npm start -- scan <project>            이슈 스캔');
  console.log('  npm start -- resolve <project>         프로젝트 상태');
  console.log('  npm start -- fix <project> <issue#>    단일 이슈 수정');
  console.log('  npm start -- fix <project> --auto      자동 일괄 수정');
}

/**
 * scan 모드: 프로젝트의 Open Issues를 파싱합니다.
 */
async function scanIssues(projectName: string): Promise<void> {
  console.log(`\n[scan] ${projectName} 이슈 스캔 시작...`);
  console.log('='.repeat(50));

  // 1. 프로젝트 해석
  const project = await resolveProject(projectName);
  console.log(`[resolve] ${project.name}: ${project.config.repo}`);
  console.log(`  Local: ${project.config.local_path} (${project.localPathExists ? 'exists' : 'NOT FOUND'})`);
  if (project.gitStatus) {
    console.log(`  Branch: ${project.gitStatus.currentBranch}`);
    console.log(`  Clean: ${project.gitStatus.isClean}`);
    if (project.gitStatus.behindRemote > 0) console.log(`  Behind: ${project.gitStatus.behindRemote}`);
    if (project.gitStatus.aheadRemote > 0) console.log(`  Ahead: ${project.gitStatus.aheadRemote}`);
  }

  // 2. Open Issues 목록 가져오기
  console.log(`\n[fetch] Fetching open issues from ${project.config.repo}...`);
  const issueList = await fetchOpenIssueNumbers(project.config.repo);
  console.log(`  Found ${issueList.length} open issues`);

  if (issueList.length === 0) {
    console.log('\n  No open issues to process.');
    return;
  }

  // 3. 각 이슈 파싱
  console.log(`\n[parse] Parsing ${issueList.length} issues...`);
  const parsed = [];
  const errors = [];

  for (const item of issueList) {
    const result = await parseIssue(item.number, project.config.repo);
    if (isParsedIssue(result)) {
      parsed.push(result);
    } else {
      errors.push(result);
    }
  }

  // 4. 우선순위별 정렬 및 출력
  const sorted = sortByPriority(parsed);

  console.log('\n' + '='.repeat(50));
  console.log(`SCAN RESULTS: ${project.name}`);
  console.log('='.repeat(50));

  const priorityGroups: Record<Priority, typeof sorted> = { P0: [], P1: [], P2: [], P3: [] };
  for (const issue of sorted) {
    priorityGroups[issue.priority].push(issue);
  }

  for (const [priority, issues] of Object.entries(priorityGroups)) {
    if (issues.length === 0) continue;
    console.log(`\n${priority} (${issues.length}건):`);
    for (const issue of issues) {
      const fixable = issue.isAutoFixable ? 'auto-fix' : 'manual';
      const files = issue.parsedContent.affectedFiles?.length ?? 0;
      console.log(`  #${issue.number} [${issue.category}] ${issue.title}`);
      console.log(`         fixable: ${fixable}, files: ${files}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}건):`);
    for (const err of errors) {
      console.log(`  #${err.issueNumber}: ${err.error}`);
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log(`Total: ${parsed.length} parsed, ${errors.length} errors`);
  console.log(`Auto-fixable: ${parsed.filter((p) => p.isAutoFixable).length}`);
  console.log(`Manual: ${parsed.filter((p) => !p.isAutoFixable).length}`);
}

/**
 * resolve 모드: 프로젝트 상태를 확인합니다.
 */
async function resolveProjectCommand(projectName?: string): Promise<void> {
  if (projectName) {
    const project = await resolveProject(projectName);
    console.log(`\n[resolve] ${project.name}`);
    console.log(`  Repo: ${project.config.repo}`);
    console.log(`  Path: ${project.config.local_path}`);
    console.log(`  Exists: ${project.localPathExists}`);
    console.log(`  Tech: ${project.config.tech_stack.backend} + ${project.config.tech_stack.frontend}`);
    console.log(`  DB: ${project.config.tech_stack.database}`);
    console.log(`  Build: ${project.config.commands.build_backend}`);
    console.log(`  Test: ${project.config.commands.test_backend}`);
    if (project.gitStatus) {
      console.log(`  Branch: ${project.gitStatus.currentBranch}`);
      console.log(`  Clean: ${project.gitStatus.isClean}`);
      console.log(`  Behind: ${project.gitStatus.behindRemote}, Ahead: ${project.gitStatus.aheadRemote}`);
    }
  } else {
    const projects = await resolveAllProjects();
    console.log(`\n[resolve] ${projects.length} enabled projects:`);
    for (const p of projects) {
      const status = p.localPathExists ? (p.gitStatus?.isClean ? 'clean' : 'dirty') : 'NOT FOUND';
      console.log(`  ${p.name}: ${p.config.repo} [${status}]`);
    }
  }
}

/**
 * fix 모드: 이슈를 수정합니다.
 *
 * @param projectName - 프로젝트명
 * @param issueArg - 이슈 번호 또는 '--auto'
 */
async function fixIssues(projectName: string, issueArg: string): Promise<void> {
  const project = await resolveProject(projectName);

  if (issueArg === '--auto') {
    // 자동 수정 가능한 이슈 일괄 처리
    await fixAutoIssues(projectName, project);
  } else {
    // 단일 이슈 수정
    const issueNumber = parseInt(issueArg, 10);
    if (isNaN(issueNumber)) {
      console.error(`Invalid issue number: ${issueArg}`);
      process.exit(1);
    }
    await fixSingleIssue(projectName, project, issueNumber);
  }
}

/**
 * 단일 이슈 수정
 */
async function fixSingleIssue(
  projectName: string,
  project: Awaited<ReturnType<typeof resolveProject>>,
  issueNumber: number,
): Promise<void> {
  console.log(`\n[fix] ${projectName} #${issueNumber} 수정 시작`);
  console.log('='.repeat(50));

  // 이슈 파싱
  const parseResult = await parseIssue(issueNumber, project.config.repo);
  if (!isParsedIssue(parseResult)) {
    console.error(`Issue #${issueNumber} parse failed: ${parseResult.error}`);
    process.exit(1);
  }

  // 수정 오케스트레이션
  const fixResult = await orchestrateFix(parseResult, project);

  // PR 생성 (수정 성공 시)
  if (['build_verified', 'test_verified', 'fix_applied'].includes(fixResult.status)) {
    const prResult = await createPullRequest(fixResult);
    printFixSummary(prResult);
  } else {
    printFixSummary(fixResult);
  }
}

/**
 * 자동 수정 가능한 이슈 일괄 처리
 */
async function fixAutoIssues(
  projectName: string,
  project: Awaited<ReturnType<typeof resolveProject>>,
): Promise<void> {
  console.log(`\n[fix --auto] ${projectName} 자동 수정 시작`);
  console.log('='.repeat(50));

  // 이슈 스캔
  const issueList = await fetchOpenIssueNumbers(project.config.repo);
  const parsed: ParsedIssue[] = [];

  for (const item of issueList) {
    const result = await parseIssue(item.number, project.config.repo);
    if (isParsedIssue(result) && result.isAutoFixable) {
      parsed.push(result);
    }
  }

  if (parsed.length === 0) {
    console.log('  자동 수정 가능한 이슈 없음');
    return;
  }

  const sorted = sortByPriority(parsed);
  console.log(`  Auto-fixable issues: ${sorted.length}건`);
  for (const issue of sorted) {
    console.log(`    #${issue.number} [${issue.priority}] ${issue.title}`);
  }

  // 일괄 수정
  const results = await orchestrateBatchFix(sorted, project);

  // 성공한 건에 대해 PR 생성
  for (let i = 0; i < results.length; i++) {
    if (['build_verified', 'test_verified', 'fix_applied'].includes(results[i].status)) {
      results[i] = await createPullRequest(results[i]);
    }
  }

  // 최종 요약
  printBatchSummary(results);
}

/**
 * 단일 수정 결과 출력
 */
function printFixSummary(result: import('./types/index.js').FixResult): void {
  console.log('\n' + '='.repeat(50));
  console.log('FIX RESULT');
  console.log('='.repeat(50));
  console.log(`  Issue: #${result.issueNumber}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Branch: ${result.branchName ?? '-'}`);
  console.log(`  Commit: ${result.commitHash?.substring(0, 8) ?? '-'}`);
  console.log(`  PR: ${result.prUrl ?? '-'}`);
  console.log(`  Files: ${result.modifiedFiles.length}`);
  console.log(`  Retries: ${result.retryCount}`);
  if (result.error) {
    console.log(`  Error: ${result.error}`);
  }
  if (result.durationMs) {
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  for (const v of result.verifications) {
    const icon = v.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${v.type}: ${v.command} (${(v.durationMs / 1000).toFixed(1)}s)`);
  }
}

/**
 * 배치 수정 결과 출력
 */
function printBatchSummary(results: import('./types/index.js').FixResult[]): void {
  const succeeded = results.filter((r) => r.status === 'pr_created' || r.status === 'test_verified' || r.status === 'build_verified');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');

  console.log('\n' + '='.repeat(50));
  console.log('BATCH FIX SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Total: ${results.length}`);
  console.log(`  Succeeded: ${succeeded.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Skipped: ${skipped.length}`);

  if (succeeded.length > 0) {
    console.log('\n  Succeeded:');
    for (const r of succeeded) {
      console.log(`    #${r.issueNumber} → ${r.prUrl ?? r.status}`);
    }
  }

  if (failed.length > 0) {
    console.log('\n  Failed:');
    for (const r of failed) {
      console.log(`    #${r.issueNumber}: ${r.error?.substring(0, 100)}`);
    }
  }
}

/**
 * 메인 엔트리포인트
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const target = args[1];

  try {
    switch (command) {
      case 'scan':
        if (!target) {
          console.error('Usage: npm start -- scan <project>');
          process.exit(1);
        }
        await scanIssues(target);
        break;

      case 'resolve':
        await resolveProjectCommand(target);
        break;

      case 'fix':
        if (!target || !args[2]) {
          console.error('Usage: npm start -- fix <project> <issue#|--auto>');
          process.exit(1);
        }
        await fixIssues(target, args[2]);
        break;

      default:
        showStatus();
        break;
    }
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
