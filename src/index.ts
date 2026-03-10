/**
 * Auto-Tobe-Agent - Autonomous Code Fixer & Docker Ops Agent
 *
 * QA Agent가 발견한 GitHub Issues를 자동으로 수정하고,
 * 운영 중인 Docker 서비스를 모니터링/배포하는 Agent
 *
 * 사용법:
 *   npm start                              # 설정 로드 및 상태 표시
 *   npm start -- scan <project>            # 이슈 스캔 및 파싱
 *   npm start -- resolve <project>         # 프로젝트 상태 확인
 *   npm start -- fix <project> <issue#>    # 단일 이슈 수정
 *   npm start -- fix <project> --auto      # 자동 수정 가능한 이슈 일괄 수정
 *   npm start -- batch [project]           # 배치 모드 (이력 관리 포함)
 *   npm start -- history [project]         # 처리 이력 조회
 *   npm start -- docker-monitor [project]  # Docker 서비스 모니터링
 *   npm start -- docker-deploy [project]   # Docker 배포 큐 처리
 *   npm start -- ops [project]             # 전체 운영 (모니터 → 수정 → 배포)
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type { ProjectsConfig, ApprovalPolicyConfig, Priority, ParsedIssue, ScheduleConfig } from './types/index.js';
import { fetchOpenIssueNumbers, parseIssue, isParsedIssue, sortByPriority } from './issue-parser.js';
import { resolveProject, resolveAllProjects } from './project-resolver.js';
import { orchestrateFix, orchestrateBatchFix } from './fix-orchestrator.js';
import { createPullRequest } from './pr-creator.js';
import {
  loadHistory,
  saveHistory,
  isAlreadyProcessed,
  recordResult,
  getProjectStats,
} from './fix-history.js';
import { requestVerification } from './verification-reporter.js';
import { monitorAllServices } from './docker-monitor.js';
import { correlateMonitorResult, createDockerGitHubIssues } from './issue-correlator.js';
import { processDeployQueue, checkMergedPRsAndEnqueue } from './docker-deployer.js';
import { executeRoundRobinBatch, checkScheduleAdjustment } from './round-robin-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadConfig<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, '..', relativePath);
  let content = readFileSync(fullPath, 'utf-8');
  content = content.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  return JSON.parse(content) as T;
}

/**
 * 기본 모드: 설정 로드 및 상태 표시
 */
function showStatus(): void {
  console.log('Auto-Tobe-Agent v1.0.0');
  console.log('='.repeat(50));

  const projects = loadConfig<ProjectsConfig>('configs/projects.json');
  console.log(`Projects config v${projects.version} loaded`);

  const enabledProjects = Object.entries(projects.projects)
    .filter(([, config]) => config.enabled)
    .map(([name]) => name);
  console.log(`Enabled projects: ${enabledProjects.join(', ')}`);

  // Docker 서비스 수 표시
  let totalDockerServices = 0;
  for (const name of enabledProjects) {
    const projConfig = projects.projects[name];
    if (projConfig.docker?.services) {
      const count = Object.keys(projConfig.docker.services).length;
      totalDockerServices += count;
      console.log(`  ${name}: ${count} Docker services`);
    }
  }
  if (totalDockerServices > 0) {
    console.log(`Total Docker services: ${totalDockerServices}`);
  }

  const policy = loadConfig<ApprovalPolicyConfig>('configs/approval-policy.json');
  console.log(`Approval policy v${policy.version} loaded`);
  console.log(`Default reviewers: ${policy.default_reviewers.join(', ')}`);

  // 스케줄 설정 표시
  const schedulePath = resolve(__dirname, '..', 'configs', 'schedule.json');
  if (existsSync(schedulePath)) {
    const schedule = loadConfig<ScheduleConfig>('configs/schedule.json');
    console.log(`\nSchedule config v${schedule.version}:`);
    console.log(`  Monitor: ${schedule.tiers.monitor.enabled ? `every ${schedule.tiers.monitor.interval_minutes}min` : 'disabled'}`);
    console.log(`  Fix: ${schedule.tiers.fix.enabled ? `at ${schedule.tiers.fix.schedule_hours.join(', ')}h` : 'disabled'}`);
    console.log(`  Deploy: ${schedule.tiers.deploy.enabled ? `${schedule.tiers.deploy.trigger}, ${schedule.tiers.deploy.allowed_hours.start}-${schedule.tiers.deploy.allowed_hours.end}h` : 'disabled'}`);
    console.log(`  Round-Robin: ${schedule.tiers.fix.round_robin ? 'enabled' : 'disabled'}`);

    // 스케줄 자동 조정 권고
    const adjustment = checkScheduleAdjustment(enabledProjects.length, schedule);
    if (adjustment) {
      console.log(`\n  [RECOMMENDATION] ${adjustment.reason}`);
      console.log(`    현재 스케줄: ${adjustment.currentScheduleHours.join(', ')}h`);
      console.log(`    권고 스케줄: ${adjustment.recommendedScheduleHours.join(', ')}h`);
    }
  }

  // 처리 이력 요약
  const history = loadHistory();
  if (history.lastRunAt) {
    console.log(`\nLast batch run: ${history.lastRunAt}`);
    for (const name of enabledProjects) {
      const stats = getProjectStats(history, name);
      if (stats.total > 0) {
        console.log(`  ${name}: ${stats.succeeded} succeeded, ${stats.failed} failed, ${stats.skipped} skipped`);
      }
    }
  }

  console.log('='.repeat(50));
  console.log('\nCommands:');
  console.log('  npm start -- scan <project>            이슈 스캔');
  console.log('  npm start -- resolve <project>         프로젝트 상태');
  console.log('  npm start -- fix <project> <issue#>    단일 이슈 수정');
  console.log('  npm start -- fix <project> --auto      자동 일괄 수정');
  console.log('  npm start -- batch [project]           배치 모드 (이력 관리)');
  console.log('  npm start -- history [project]         처리 이력 조회');
  console.log('  npm start -- docker-monitor [project]  Docker 서비스 모니터링');
  console.log('  npm start -- docker-deploy [project]   Docker 배포 큐 처리');
  console.log('  npm start -- ops [project]             전체 운영 (모니터+수정+배포)');
}

/**
 * scan 모드: 프로젝트의 Open Issues를 파싱합니다.
 */
async function scanIssues(projectName: string): Promise<void> {
  console.log(`\n[scan] ${projectName} 이슈 스캔 시작...`);
  console.log('='.repeat(50));

  const project = await resolveProject(projectName);
  console.log(`[resolve] ${project.name}: ${project.config.repo}`);
  console.log(`  Local: ${project.config.local_path} (${project.localPathExists ? 'exists' : 'NOT FOUND'})`);
  if (project.gitStatus) {
    console.log(`  Branch: ${project.gitStatus.currentBranch}`);
    console.log(`  Clean: ${project.gitStatus.isClean}`);
    if (project.gitStatus.behindRemote > 0) console.log(`  Behind: ${project.gitStatus.behindRemote}`);
    if (project.gitStatus.aheadRemote > 0) console.log(`  Ahead: ${project.gitStatus.aheadRemote}`);
  }

  console.log(`\n[fetch] Fetching open issues from ${project.config.repo}...`);
  const issueList = await fetchOpenIssueNumbers(project.config.repo);
  console.log(`  Found ${issueList.length} open issues`);

  if (issueList.length === 0) {
    console.log('\n  No open issues to process.');
    return;
  }

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
    if (project.config.docker?.services) {
      console.log(`  Docker services: ${Object.keys(project.config.docker.services).join(', ')}`);
    }
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
      const dockerCount = p.config.docker?.services ? Object.keys(p.config.docker.services).length : 0;
      console.log(`  ${p.name}: ${p.config.repo} [${status}] (${dockerCount} docker services)`);
    }
  }
}

/**
 * fix 모드: 이슈를 수정합니다.
 */
async function fixIssues(projectName: string, issueArg: string): Promise<void> {
  const project = await resolveProject(projectName);

  if (issueArg === '--auto') {
    await fixAutoIssues(projectName, project);
  } else {
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

  const parseResult = await parseIssue(issueNumber, project.config.repo);
  if (!isParsedIssue(parseResult)) {
    console.error(`Issue #${issueNumber} parse failed: ${parseResult.error}`);
    process.exit(1);
  }

  const fixResult = await orchestrateFix(parseResult, project);

  // 이력 기록
  const history = loadHistory();
  recordResult(history, fixResult);

  if (['build_verified', 'test_verified', 'fix_applied'].includes(fixResult.status)) {
    let prResult = await createPullRequest(fixResult);
    // PR 생성 성공 시 적합성 리포트 게시
    if (prResult.status === 'pr_created') {
      prResult = await requestVerification(parseResult, prResult);
    }
    recordResult(history, prResult);
    saveHistory(history);
    printFixSummary(prResult);
  } else {
    saveHistory(history);
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

  const results = await orchestrateBatchFix(sorted, project);

  const history = loadHistory();
  for (let i = 0; i < results.length; i++) {
    if (['build_verified', 'test_verified', 'fix_applied'].includes(results[i].status)) {
      results[i] = await createPullRequest(results[i]);
      // PR 생성 성공 시 적합성 리포트 게시
      if (results[i].status === 'pr_created') {
        results[i] = await requestVerification(sorted[i], results[i]);
      }
    }
    recordResult(history, results[i]);
  }
  saveHistory(history);

  printBatchSummary(results);
}

/**
 * batch 모드: 이력 관리를 포함한 배치 실행.
 * 이미 처리된 이슈는 건너뜁니다.
 *
 * round_robin: true && 대상 프로젝트 > 1 → Round-Robin 경로
 * 그 외 → 기존 순차 처리 (하위 호환)
 */
async function runBatch(projectName?: string): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`\n[batch] Auto-Tobe-Agent Batch Run`);
  console.log(`  Started: ${timestamp}`);
  console.log('='.repeat(50));

  const projectsConfig = loadConfig<ProjectsConfig>('configs/projects.json');

  // 대상 프로젝트 결정
  const targetProjects = projectName
    ? [projectName]
    : Object.entries(projectsConfig.projects)
        .filter(([, cfg]) => cfg.enabled)
        .map(([name]) => name);

  // 스케줄 설정 로드
  const schedulePath = resolve(__dirname, '..', 'configs', 'schedule.json');
  const hasSchedule = existsSync(schedulePath);
  const scheduleConfig = hasSchedule
    ? loadConfig<ScheduleConfig>('configs/schedule.json')
    : null;
  const fixConfig = scheduleConfig?.tiers.fix;

  // Round-Robin 조건: round_robin 활성화 && 대상 프로젝트 2개 이상
  const useRoundRobin = fixConfig?.round_robin === true && targetProjects.length > 1;

  if (useRoundRobin && scheduleConfig) {
    console.log(`  Mode: Round-Robin (${targetProjects.length} projects)`);
    const result = await executeRoundRobinBatch(targetProjects, scheduleConfig);

    // Round-Robin 결과 요약
    console.log('\n' + '='.repeat(50));
    console.log('BATCH SUMMARY (Round-Robin)');
    console.log('='.repeat(50));
    console.log(`  Processed: ${result.totalProcessed}`);
    console.log(`  Succeeded: ${result.succeeded}`);
    console.log(`  Failed: ${result.failed}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Timed out: ${result.timedOut ? 'YES' : 'no'}`);
    console.log(`  Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
    for (const [proj, stats] of Object.entries(result.perProject)) {
      console.log(`  [${proj}] processed: ${stats.processed}, ok: ${stats.succeeded}, fail: ${stats.failed}`);
    }
    console.log(`  Completed: ${result.completedAt}`);
    return;
  }

  // 순차 처리 경로 (하위 호환)
  console.log(`  Mode: Sequential`);
  const history = loadHistory();
  const maxPerService = fixConfig?.max_issues_per_service ?? Infinity;

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalSuccess = 0;

  for (const name of targetProjects) {
    console.log(`\n[batch] Project: ${name}`);
    console.log('-'.repeat(40));

    const project = await resolveProject(name);

    if (!project.localPathExists) {
      console.log(`  SKIP: 로컬 경로 없음 (${project.config.local_path})`);
      continue;
    }

    // 이슈 스캔
    const issueList = await fetchOpenIssueNumbers(project.config.repo);
    const parsed: ParsedIssue[] = [];

    for (const item of issueList) {
      // 이미 처리된 이슈 건너뛰기
      if (isAlreadyProcessed(history, name, item.number)) {
        console.log(`  #${item.number}: already processed, skipping`);
        totalSkipped++;
        continue;
      }

      const result = await parseIssue(item.number, project.config.repo);
      if (isParsedIssue(result) && result.isAutoFixable) {
        parsed.push(result);
      }
    }

    if (parsed.length === 0) {
      console.log('  처리할 새 이슈 없음');
      continue;
    }

    const sorted = sortByPriority(parsed);
    // max_issues_per_service 적용
    const limited = sorted.slice(0, maxPerService);
    if (sorted.length > limited.length) {
      console.log(`  새로 처리할 이슈: ${limited.length}건 (쿼터 ${maxPerService}, 전체 ${sorted.length}건)`);
    } else {
      console.log(`  새로 처리할 이슈: ${limited.length}건`);
    }

    // 순차 처리
    for (const issue of limited) {
      console.log(`\n  Processing #${issue.number} [${issue.priority}]...`);
      totalProcessed++;

      const fixResult = await orchestrateFix(issue, project);
      recordResult(history, fixResult);

      if (['build_verified', 'test_verified', 'fix_applied'].includes(fixResult.status)) {
        let prResult = await createPullRequest(fixResult);
        // PR 생성 성공 시 적합성 리포트 게시
        if (prResult.status === 'pr_created') {
          prResult = await requestVerification(issue, prResult);
        }
        recordResult(history, prResult);
        totalSuccess++;
        console.log(`  #${issue.number} → ${prResult.prUrl ?? prResult.status}`);
      } else if (fixResult.status === 'skipped') {
        totalSkipped++;
      } else {
        totalFailed++;
        console.log(`  #${issue.number} FAILED: ${fixResult.error}`);
      }

      // 매 이슈 처리 후 이력 저장 (중간 크래시 대비)
      saveHistory(history);
    }
  }

  // 최종 요약
  console.log('\n' + '='.repeat(50));
  console.log('BATCH SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Processed: ${totalProcessed}`);
  console.log(`  Succeeded: ${totalSuccess}`);
  console.log(`  Failed: ${totalFailed}`);
  console.log(`  Skipped (already done): ${totalSkipped}`);
  console.log(`  Completed: ${new Date().toISOString()}`);
}

/**
 * history 모드: 처리 이력을 조회합니다.
 */
function showHistory(projectName?: string): void {
  const history = loadHistory();

  console.log('\n[history] Fix History');
  console.log('='.repeat(50));

  if (history.lastRunAt) {
    console.log(`Last run: ${history.lastRunAt}`);
  } else {
    console.log('No history recorded yet.');
    return;
  }

  const entries = Object.values(history.entries);
  const filtered = projectName
    ? entries.filter((e) => e.project === projectName)
    : entries;

  if (filtered.length === 0) {
    console.log('  No entries found.');
    return;
  }

  // 프로젝트별 그룹핑
  const byProject: Record<string, typeof filtered> = {};
  for (const entry of filtered) {
    if (!byProject[entry.project]) byProject[entry.project] = [];
    byProject[entry.project].push(entry);
  }

  for (const [proj, projEntries] of Object.entries(byProject)) {
    const stats = getProjectStats(history, proj);
    console.log(`\n  ${proj} (${stats.total} total: ${stats.succeeded} ok, ${stats.failed} fail, ${stats.skipped} skip)`);

    for (const entry of projEntries) {
      const statusIcon = entry.status === 'failed' ? 'FAIL'
        : entry.status === 'skipped' ? 'SKIP'
        : 'OK';
      const pr = entry.prUrl ? ` → ${entry.prUrl}` : '';
      console.log(`    [${statusIcon}] #${entry.issueNumber} ${entry.status}${pr}`);
      if (entry.error) {
        console.log(`           ${entry.error.substring(0, 80)}`);
      }
    }
  }
}

/**
 * docker-monitor 모드: Docker 서비스를 점검합니다.
 * 이상 감지 시 이슈 상관관계 분석 후 GitHub Issue를 생성합니다.
 */
async function runDockerMonitor(projectName?: string): Promise<void> {
  console.log('\n[docker-monitor] Docker Service Health Check');
  console.log('='.repeat(50));

  // 1. 서비스 모니터링
  const monitorResult = await monitorAllServices(projectName);

  // 2. 이슈가 있으면 상관관계 분석
  if (monitorResult.issues.length > 0) {
    console.log('\n[correlate] Analyzing detected issues...');

    const config = loadConfig<ProjectsConfig>('configs/projects.json');
    const repoMap: Record<string, string> = {};
    for (const [name, cfg] of Object.entries(config.projects)) {
      repoMap[name] = cfg.repo;
    }

    const correlationResult = await correlateMonitorResult(monitorResult, repoMap);

    // 3. 새 이슈 GitHub에 생성
    const newIssues = correlationResult.results.filter((r) => r.needsGitHubIssue);
    if (newIssues.length > 0) {
      console.log(`\n[create] Creating ${newIssues.length} GitHub issues...`);
      const { created, errors } = await createDockerGitHubIssues(
        correlationResult.results,
        repoMap,
      );
      console.log(`  Created: ${created}, Errors: ${errors}`);
    }
  }

  console.log(`\n[docker-monitor] Completed (${monitorResult.durationMs}ms)`);
}

/**
 * docker-deploy 모드: 배포 큐를 처리합니다.
 */
async function runDockerDeploy(projectName?: string): Promise<void> {
  console.log('\n[docker-deploy] Docker Deploy Queue Processing');
  console.log('='.repeat(50));

  // 머지된 PR 확인 → 배포 큐 추가
  console.log('[deploy] Checking merged PRs...');
  const enqueued = await checkMergedPRsAndEnqueue(projectName);
  console.log(`  Enqueued: ${enqueued} services`);

  // 배포 큐 처리
  await processDeployQueue(projectName);
}

/**
 * ops 모드: 전체 운영 파이프라인 (모니터 → 수정 → 배포)
 */
async function runOps(projectName?: string): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log('\n' + '='.repeat(60));
  console.log('  Auto-Tobe-Agent OPS Pipeline');
  console.log(`  Started: ${timestamp}`);
  console.log('='.repeat(60));

  // Tier 1: Docker 모니터링
  console.log('\n>>> Tier 1: Docker Service Monitoring');
  await runDockerMonitor(projectName);

  // Tier 2: 이슈 수정 배치
  console.log('\n>>> Tier 2: Issue Fix Batch');
  await runBatch(projectName);

  // Tier 3: 배포 큐 처리
  console.log('\n>>> Tier 3: Docker Deploy');
  await runDockerDeploy(projectName);

  console.log('\n' + '='.repeat(60));
  console.log(`  OPS Pipeline Completed: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
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
      console.log(`    #${r.issueNumber}: ${r.error}`);
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

      case 'batch':
        await runBatch(target);
        break;

      case 'history':
        showHistory(target);
        break;

      case 'docker-monitor':
        await runDockerMonitor(target);
        break;

      case 'docker-deploy':
        await runDockerDeploy(target);
        break;

      case 'ops':
        await runOps(target);
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
