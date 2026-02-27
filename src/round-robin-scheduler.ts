/**
 * Round-Robin Scheduler
 *
 * 복수 프로젝트(서비스)의 이슈를 공정하게 분배하여 처리합니다.
 * A#1 → B#1 → C#1 → A#2 → B#2 → C#2 → ... 순으로 인터리빙합니다.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type {
  ParsedIssue,
  FixResult,
  ScheduleConfig,
  RoundRobinState,
  ServiceWorkQueue,
  PlannedWorkItem,
  BatchPlan,
  RoundRobinBatchResult,
  ScheduleAdjustment,
} from './types/index.js';
import { resolveProject } from './project-resolver.js';
import { orchestrateFix } from './fix-orchestrator.js';
import { createPullRequest } from './pr-creator.js';
import {
  loadHistory,
  saveHistory,
  isAlreadyProcessed,
  recordResult,
} from './fix-history.js';
import { fetchOpenIssueNumbers, parseIssue, isParsedIssue, sortByPriority } from './issue-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOGS_DIR = resolve(__dirname, '..', 'logs');
const STATE_FILE = resolve(LOGS_DIR, 'round-robin-state.json');

/**
 * Round-Robin 상태를 로드합니다. 없으면 초기 상태를 반환합니다.
 */
export function loadRoundRobinState(): RoundRobinState {
  if (!existsSync(STATE_FILE)) {
    return {
      lastServiceIndex: -1,
      batchQuota: {},
      lastRunAt: '',
      lastBatchTotal: 0,
    };
  }

  const content = readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(content) as RoundRobinState;
}

/**
 * Round-Robin 상태를 저장합니다.
 */
export function saveRoundRobinState(state: RoundRobinState): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 인터리빙 실행 계획을 생성합니다.
 *
 * 알고리즘:
 * 1. 각 프로젝트의 이슈 큐를 우선순위순으로 정렬
 * 2. 이전 배치의 마지막 서비스 인덱스 다음부터 시작
 * 3. 라운드 로빈으로 각 프로젝트에서 1건씩 가져옴
 * 4. 프로젝트의 이슈가 소진되거나 쿼터(max_issues_per_service)에 도달하면 스킵
 * 5. 모든 프로젝트가 소진/쿼터 도달이면 종료
 */
export function buildBatchPlan(
  queues: ServiceWorkQueue[],
  previousState: RoundRobinState,
): BatchPlan {
  const plan: PlannedWorkItem[] = [];
  const projectCount = queues.length;

  if (projectCount === 0) {
    return {
      createdAt: new Date().toISOString(),
      items: [],
      queues,
      totalProjects: 0,
      startIndex: 0,
    };
  }

  // 이전 배치의 마지막 인덱스 다음부터 시작
  const startIndex = (previousState.lastServiceIndex + 1) % projectCount;
  let order = 0;
  let exhaustedCount = 0;

  // 모든 프로젝트가 소진/쿼터 도달할 때까지 반복
  while (exhaustedCount < projectCount) {
    exhaustedCount = 0;

    for (let i = 0; i < projectCount; i++) {
      const idx = (startIndex + i) % projectCount;
      const queue = queues[idx];

      // 쿼터 도달 또는 이슈 소진 체크
      if (queue.consumed >= queue.maxQuota || queue.consumed >= queue.issues.length) {
        exhaustedCount++;
        continue;
      }

      const issue = queue.issues[queue.consumed];
      plan.push({
        order: order++,
        project: queue.project,
        issueNumber: issue.issueNumber,
        priority: issue.priority,
        title: issue.title,
      });
      queue.consumed++;
    }

    // 이번 라운드에서 아무것도 추가하지 못했으면 종료
    if (exhaustedCount >= projectCount) break;
  }

  return {
    createdAt: new Date().toISOString(),
    items: plan,
    queues,
    totalProjects: projectCount,
    startIndex,
  };
}

/**
 * 수정 간 쿨다운을 적용합니다.
 */
export async function applyCooldown(seconds: number): Promise<void> {
  if (seconds <= 0) return;
  console.log(`  [cooldown] ${seconds}초 대기...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Round-Robin 배치를 실행합니다.
 *
 * @param targetProjects - 대상 프로젝트명 배열
 * @param scheduleConfig - 스케줄 설정
 * @returns 배치 실행 결과
 */
export async function executeRoundRobinBatch(
  targetProjects: string[],
  scheduleConfig: ScheduleConfig,
): Promise<RoundRobinBatchResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const fixConfig = scheduleConfig.tiers.fix;
  const maxDurationMs = fixConfig.max_duration_minutes * 60 * 1000;

  console.log(`\n[round-robin] Round-Robin Batch 시작`);
  console.log(`  대상 프로젝트: ${targetProjects.join(', ')}`);
  console.log(`  max_issues_per_service: ${fixConfig.max_issues_per_service}`);
  console.log(`  cooldown: ${fixConfig.cooldown_between_fixes_seconds}s`);
  console.log(`  시간 예산: ${fixConfig.max_duration_minutes}분`);

  // 1. Round-Robin 상태 로드
  const previousState = loadRoundRobinState();
  const history = loadHistory();

  // 2. 각 프로젝트의 이슈 큐 구성
  const queues: ServiceWorkQueue[] = [];
  for (const name of targetProjects) {
    const project = await resolveProject(name);

    if (!project.localPathExists) {
      console.log(`  [${name}] SKIP: 로컬 경로 없음`);
      continue;
    }

    const issueList = await fetchOpenIssueNumbers(project.config.repo);
    const parsed: ParsedIssue[] = [];

    for (const item of issueList) {
      if (isAlreadyProcessed(history, name, item.number)) {
        continue;
      }
      const result = await parseIssue(item.number, project.config.repo);
      if (isParsedIssue(result) && result.isAutoFixable) {
        parsed.push(result);
      }
    }

    const sorted = sortByPriority(parsed);
    queues.push({
      project: name,
      issues: sorted.map((issue) => ({
        issueNumber: issue.number,
        priority: issue.priority,
        title: issue.title,
      })),
      consumed: 0,
      maxQuota: fixConfig.max_issues_per_service,
    });

    console.log(`  [${name}] ${sorted.length}건 대기 (쿼터 ${fixConfig.max_issues_per_service})`);
  }

  // 3. 실행 계획 생성
  const plan = buildBatchPlan(queues, previousState);
  console.log(`\n[round-robin] 실행 계획: ${plan.items.length}건`);
  for (const item of plan.items) {
    console.log(`  ${item.order + 1}. [${item.project}] #${item.issueNumber} ${item.priority} ${item.title}`);
  }

  // 4. 계획 실행
  const perProject: Record<string, { processed: number; succeeded: number; failed: number }> = {};
  const results: FixResult[] = [];
  let totalProcessed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let timedOut = false;

  // 프로젝트별 ParsedIssue 캐시 (이슈 재파싱 방지)
  const issueCache = new Map<string, ParsedIssue>();
  for (const queue of queues) {
    const project = await resolveProject(queue.project);
    for (const issueInfo of queue.issues) {
      const result = await parseIssue(issueInfo.issueNumber, project.config.repo);
      if (isParsedIssue(result)) {
        issueCache.set(`${queue.project}#${issueInfo.issueNumber}`, result);
      }
    }
  }

  let lastServiceIndex = previousState.lastServiceIndex;

  for (const item of plan.items) {
    // 시간 예산 체크
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxDurationMs) {
      console.log(`\n  [round-robin] 시간 예산 초과 (${fixConfig.max_duration_minutes}분), 조기 종료`);
      timedOut = true;
      break;
    }

    const cacheKey = `${item.project}#${item.issueNumber}`;
    const parsedIssue = issueCache.get(cacheKey);
    if (!parsedIssue) {
      console.log(`  [${item.project}] #${item.issueNumber}: 파싱 실패, 스킵`);
      skipped++;
      continue;
    }

    // 쿨다운 적용 (첫 번째 건 제외)
    if (totalProcessed > 0) {
      await applyCooldown(fixConfig.cooldown_between_fixes_seconds);
    }

    console.log(`\n  [${item.order + 1}/${plan.items.length}] [${item.project}] #${item.issueNumber} [${item.priority}] 처리 중...`);
    totalProcessed++;

    if (!perProject[item.project]) {
      perProject[item.project] = { processed: 0, succeeded: 0, failed: 0 };
    }
    perProject[item.project].processed++;

    const project = await resolveProject(item.project);
    const fixResult = await orchestrateFix(parsedIssue, project);
    recordResult(history, fixResult);

    if (['build_verified', 'test_verified', 'fix_applied'].includes(fixResult.status)) {
      const prResult = await createPullRequest(fixResult);
      recordResult(history, prResult);
      results.push(prResult);
      succeeded++;
      perProject[item.project].succeeded++;
      console.log(`  #${item.issueNumber} → ${prResult.prUrl ?? prResult.status}`);
    } else if (fixResult.status === 'skipped') {
      results.push(fixResult);
      skipped++;
    } else {
      results.push(fixResult);
      failed++;
      perProject[item.project].failed++;
      console.log(`  #${item.issueNumber} FAILED: ${fixResult.error}`);
    }

    // 매 이슈 처리 후 이력 저장 (중간 크래시 대비)
    saveHistory(history);

    // 마지막 서비스 인덱스 업데이트
    const projectIdx = queues.findIndex((q) => q.project === item.project);
    if (projectIdx !== -1) {
      lastServiceIndex = projectIdx;
    }
  }

  // 5. 상태 저장
  const newState: RoundRobinState = {
    lastServiceIndex,
    batchQuota: Object.fromEntries(
      queues.map((q) => [q.project, q.consumed]),
    ),
    lastRunAt: new Date().toISOString(),
    lastBatchTotal: totalProcessed,
  };
  saveRoundRobinState(newState);

  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    totalDurationMs: Date.now() - startTime,
    totalProcessed,
    succeeded,
    failed,
    skipped,
    timedOut,
    perProject,
    results,
  };
}

/**
 * 서비스 수 기반 스케줄 확장 권고를 확인합니다.
 *
 * scaling.add_batch_run_at_services 이상이면 배치 횟수 증가를 권고합니다.
 */
export function checkScheduleAdjustment(
  enabledProjectCount: number,
  scheduleConfig: ScheduleConfig,
): ScheduleAdjustment | null {
  const { scaling, tiers } = scheduleConfig;

  if (!scaling.auto_adjust_schedule) return null;
  if (enabledProjectCount < scaling.add_batch_run_at_services) return null;

  const currentHours = tiers.fix.schedule_hours;
  const extraHours = scaling.extra_schedule_hours;

  // 이미 확장된 스케줄과 동일하면 권고하지 않음
  const merged = [...new Set([...currentHours, ...extraHours])].sort((a, b) => a - b);
  if (JSON.stringify(currentHours.slice().sort((a, b) => a - b)) === JSON.stringify(merged)) {
    return null;
  }

  return {
    reason: `서비스 ${enabledProjectCount}개 (임계값 ${scaling.add_batch_run_at_services}개 이상): 배치 스케줄 확장 권고`,
    currentServiceCount: enabledProjectCount,
    threshold: scaling.add_batch_run_at_services,
    currentScheduleHours: currentHours,
    recommendedScheduleHours: merged,
  };
}
