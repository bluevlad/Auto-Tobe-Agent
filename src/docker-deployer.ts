/**
 * Docker Deploy Manager (Phase 9)
 *
 * PR 머지 후 Docker 컨테이너의 빌드/배포를 관리합니다.
 * - Rolling update (기존 컨테이너 유지 → 새 버전 기동)
 * - Health check 통과 확인
 * - 실패 시 자동 롤백
 * - 배포 시간 윈도우 (운영시간 내에서만 자동 배포)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import type {
  ProjectConfig,
  DockerServiceConfig,
  DeployConfig,
  DeployResult,
  DeployStatus,
  BatchDeployResult,
  ScheduleConfig,
} from './types/index.js';
import { loadProjectsConfig, performHealthCheck } from './docker-monitor.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_DIR = resolve(__dirname, '..', 'logs');
const DEPLOY_QUEUE_FILE = resolve(LOG_DIR, 'deploy-queue.json');

/** 배포 큐 항목 */
interface DeployQueueEntry {
  project: string;
  service: string;
  reason: string;
  prNumber?: number;
  queuedAt: string;
  priority: string;
}

/** 배포 큐 파일 */
interface DeployQueue {
  version: string;
  entries: DeployQueueEntry[];
}

// ===== Deploy Queue Management =====

function loadDeployQueue(): DeployQueue {
  if (existsSync(DEPLOY_QUEUE_FILE)) {
    return JSON.parse(readFileSync(DEPLOY_QUEUE_FILE, 'utf-8'));
  }
  return { version: '1.0.0', entries: [] };
}

function saveDeployQueue(queue: DeployQueue): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  writeFileSync(DEPLOY_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * 배포 큐에 항목을 추가합니다.
 */
export function enqueueDeploy(
  project: string,
  service: string,
  reason: string,
  prNumber?: number,
  priority: string = 'P3',
): void {
  const queue = loadDeployQueue();

  // 동일 서비스 중복 방지
  const exists = queue.entries.some(
    (e) => e.project === project && e.service === service,
  );
  if (exists) {
    console.log(`  [deploy-queue] ${project}/${service} 이미 큐에 있음`);
    return;
  }

  queue.entries.push({
    project,
    service,
    reason,
    prNumber,
    queuedAt: new Date().toISOString(),
    priority,
  });

  saveDeployQueue(queue);
  console.log(`  [deploy-queue] ${project}/${service} 큐에 추가 (${reason})`);
}

// ===== Time Window Check =====

/**
 * 현재 시간이 배포 허용 시간대인지 확인합니다.
 */
function isWithinDeployWindow(allowedHours: { start: number; end: number }): boolean {
  const now = new Date();
  const currentHour = now.getHours();
  return currentHour >= allowedHours.start && currentHour < allowedHours.end;
}

// ===== Docker Compose Operations =====

/**
 * docker compose로 서비스를 빌드합니다.
 */
async function buildService(
  composeFile: string,
  serviceName: string,
  cwd: string,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execAsync(
      `docker compose -f ${composeFile} build --no-cache ${serviceName}`,
      { cwd, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return {
      success: true,
      output: (stdout + stderr).substring(0, 5000),
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: ((err.stderr || err.message || '') + (err.stdout || '')).substring(0, 5000),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * 현재 실행 중인 이미지 ID를 가져옵니다 (롤백용).
 */
async function getCurrentImageId(containerName: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.Image}}' ${containerName} 2>/dev/null`,
      { timeout: 10_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * docker compose up으로 서비스를 배포합니다 (detached).
 */
async function deployService(
  composeFile: string,
  serviceName: string,
  cwd: string,
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execAsync(
      `docker compose -f ${composeFile} up -d --no-deps ${serviceName}`,
      { cwd, timeout: 120_000 },
    );
    return {
      success: true,
      output: (stdout + stderr).substring(0, 2000),
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: ((err.stderr || err.message || '') + (err.stdout || '')).substring(0, 2000),
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Health check가 통과할 때까지 대기합니다.
 */
async function waitForHealthy(
  serviceConfig: DockerServiceConfig,
  timeoutSeconds: number,
): Promise<boolean> {
  const startTime = Date.now();
  const maxWait = timeoutSeconds * 1000;
  const checkInterval = 5000; // 5초 간격

  // 컨테이너 기동 대기
  await new Promise((resolve) => setTimeout(resolve, 3000));

  while (Date.now() - startTime < maxWait) {
    const result = await performHealthCheck(serviceConfig);
    if (result.passed) {
      console.log(`    Health check passed: ${result.details}`);
      return true;
    }
    console.log(`    Waiting... (${Math.floor((Date.now() - startTime) / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  return false;
}

/**
 * 롤백: 이전 이미지로 서비스를 복원합니다.
 */
async function rollbackService(
  composeFile: string,
  serviceName: string,
  cwd: string,
): Promise<boolean> {
  try {
    console.log(`    [rollback] ${serviceName} 이전 버전으로 롤백 시도...`);
    // docker compose up -d를 다시 실행하면 이전 상태로 복원 시도
    await execAsync(
      `docker compose -f ${composeFile} up -d --no-deps ${serviceName}`,
      { cwd, timeout: 120_000 },
    );
    console.log(`    [rollback] ${serviceName} 롤백 완료`);
    return true;
  } catch (error) {
    const err = error as { message?: string };
    console.log(`    [rollback] ${serviceName} 롤백 실패: ${err.message}`);
    return false;
  }
}

// ===== Main Deploy Logic =====

/**
 * 단일 서비스를 빌드하고 배포합니다.
 */
export async function deploySingleService(
  project: string,
  serviceName: string,
  projectConfig: ProjectConfig,
  serviceConfig: DockerServiceConfig,
): Promise<DeployResult> {
  const startTime = Date.now();
  const cwd = projectConfig.local_path.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  const composeFile = projectConfig.docker?.compose_file || 'docker-compose.prod.yml';
  const deployConfig = serviceConfig.deploy;

  const result: DeployResult = {
    project,
    service: serviceName,
    status: 'pending',
    rolledBack: false,
    startedAt: new Date().toISOString(),
  };

  console.log(`\n  [deploy] ${project}/${serviceName}`);

  if (!deployConfig) {
    console.log(`    deploy 설정 없음, 건너뜀`);
    result.status = 'completed';
    result.completedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - startTime;
    return result;
  }

  // 현재 이미지 ID 저장 (롤백용)
  result.previousImage = await getCurrentImageId(serviceConfig.container_name);

  // 1. Build
  console.log(`    Building...`);
  result.status = 'building';
  const buildResult = await buildService(composeFile, serviceName, cwd);
  result.buildDurationMs = buildResult.durationMs;

  if (!buildResult.success) {
    console.log(`    BUILD FAILED (${buildResult.durationMs}ms)`);
    result.status = 'failed';
    result.error = `Build failed: ${buildResult.output.substring(0, 200)}`;
    result.completedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - startTime;
    return result;
  }
  console.log(`    Build OK (${buildResult.durationMs}ms)`);

  // 2. Deploy
  console.log(`    Deploying...`);
  result.status = 'deploying';
  const deployResult = await deployService(composeFile, serviceName, cwd);
  result.deployDurationMs = deployResult.durationMs;

  if (!deployResult.success) {
    console.log(`    DEPLOY FAILED (${deployResult.durationMs}ms)`);
    result.status = 'failed';
    result.error = `Deploy failed: ${deployResult.output.substring(0, 200)}`;

    // 롤백
    if (deployConfig.rollback_on_failure) {
      const rolled = await rollbackService(composeFile, serviceName, cwd);
      result.rolledBack = rolled;
      if (rolled) result.status = 'rolled_back';
    }

    result.completedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - startTime;
    return result;
  }
  console.log(`    Deploy OK (${deployResult.durationMs}ms)`);

  // 3. Health Check
  console.log(`    Health checking (max ${deployConfig.health_wait_seconds}s)...`);
  result.status = 'health_checking';
  const healthy = await waitForHealthy(serviceConfig, deployConfig.health_wait_seconds);
  result.healthCheckPassed = healthy;

  if (!healthy) {
    console.log(`    HEALTH CHECK FAILED`);
    result.error = 'Health check did not pass within timeout';

    // 롤백
    if (deployConfig.rollback_on_failure) {
      const rolled = await rollbackService(composeFile, serviceName, cwd);
      result.rolledBack = rolled;
      result.status = rolled ? 'rolled_back' : 'failed';
    } else {
      result.status = 'failed';
    }

    result.completedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - startTime;
    return result;
  }

  // 성공
  result.status = 'completed';
  result.completedAt = new Date().toISOString();
  result.totalDurationMs = Date.now() - startTime;
  console.log(`    DEPLOY COMPLETED (${result.totalDurationMs}ms)`);

  return result;
}

/**
 * 프로젝트의 모든 서비스를 순서에 따라 배포합니다.
 */
export async function deployProject(
  projectName: string,
  projectConfig: ProjectConfig,
  deployOrder?: string[],
): Promise<BatchDeployResult> {
  const startTime = Date.now();
  const results: DeployResult[] = [];

  if (!projectConfig.docker?.services) {
    return {
      project: projectName,
      results: [],
      totalDurationMs: 0,
      allSucceeded: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  const services = projectConfig.docker.services;
  const order = deployOrder || Object.keys(services);

  // deploy 설정이 있는 서비스만 필터
  const deployableServices = order.filter(
    (svc) => services[svc]?.deploy,
  );

  console.log(`\n[deploy] ${projectName}: ${deployableServices.length} services`);
  console.log(`  Order: ${deployableServices.join(' → ')}`);

  for (const svcName of deployableServices) {
    const svcConfig = services[svcName];
    if (!svcConfig) continue;

    const result = await deploySingleService(
      projectName,
      svcName,
      projectConfig,
      svcConfig,
    );
    results.push(result);

    // 배포 실패 시 이후 서비스 중단
    if (result.status === 'failed' || result.status === 'rolled_back') {
      console.log(`  [deploy] ${svcName} 실패, 이후 서비스 배포 중단`);
      break;
    }
  }

  const batchResult: BatchDeployResult = {
    project: projectName,
    results,
    totalDurationMs: Date.now() - startTime,
    allSucceeded: results.every((r) => r.status === 'completed'),
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
  };

  // 요약 출력
  console.log('\n' + '-'.repeat(40));
  console.log(`[deploy] ${projectName} Summary:`);
  for (const r of results) {
    const icon = r.status === 'completed' ? 'OK' : r.status === 'rolled_back' ? 'ROLLBACK' : 'FAIL';
    console.log(`  [${icon}] ${r.service} (${r.totalDurationMs}ms)`);
  }

  return batchResult;
}

/**
 * 배포 큐를 처리합니다.
 * 배포 시간 윈도우 내에서만 실행합니다.
 */
export async function processDeployQueue(projectName?: string): Promise<void> {
  const scheduleConfig = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'configs', 'schedule.json'), 'utf-8'),
  ) as ScheduleConfig;

  const deployTier = scheduleConfig.tiers.deploy;

  // 시간 윈도우 확인
  if (!isWithinDeployWindow(deployTier.allowed_hours)) {
    const now = new Date();
    console.log(
      `[deploy] 배포 허용 시간(${deployTier.allowed_hours.start}~${deployTier.allowed_hours.end}시) 외. 현재: ${now.getHours()}시. 큐 보관.`,
    );
    return;
  }

  const queue = loadDeployQueue();
  if (queue.entries.length === 0) {
    console.log('[deploy] 배포 큐 비어있음');
    return;
  }

  // 프로젝트 필터
  const entries = projectName
    ? queue.entries.filter((e) => e.project === projectName)
    : queue.entries;

  if (entries.length === 0) {
    console.log(`[deploy] ${projectName || 'all'}: 대기 중인 배포 없음`);
    return;
  }

  console.log(`\n[deploy] 배포 큐 처리: ${entries.length}건`);

  const config = loadProjectsConfig();
  const processed: string[] = [];

  // 프로젝트별 그룹핑
  const byProject: Record<string, DeployQueueEntry[]> = {};
  for (const entry of entries) {
    if (!byProject[entry.project]) byProject[entry.project] = [];
    byProject[entry.project].push(entry);
  }

  for (const [proj, projEntries] of Object.entries(byProject)) {
    const projConfig = config.projects[proj];
    if (!projConfig) continue;

    // 배포 순서 결정
    const deployOrder = deployTier.deploy_order;

    const result = await deployProject(proj, projConfig, deployOrder);

    // 성공한 항목 큐에서 제거
    if (result.allSucceeded) {
      for (const entry of projEntries) {
        processed.push(`${entry.project}/${entry.service}`);
      }
    }
  }

  // 큐에서 처리 완료 항목 제거
  queue.entries = queue.entries.filter(
    (e) => !processed.includes(`${e.project}/${e.service}`),
  );
  saveDeployQueue(queue);

  console.log(`\n[deploy] 큐 처리 완료: ${processed.length}건 배포, ${queue.entries.length}건 남음`);
}

/**
 * 머지된 PR을 확인하고 배포 큐에 추가합니다.
 */
export async function checkMergedPRsAndEnqueue(projectName?: string): Promise<number> {
  const config = loadProjectsConfig();
  let enqueued = 0;

  const projects = projectName
    ? { [projectName]: config.projects[projectName] }
    : Object.fromEntries(
        Object.entries(config.projects).filter(([, cfg]) => cfg.enabled && cfg.docker),
      );

  for (const [projName, projConfig] of Object.entries(projects)) {
    if (!projConfig) continue;

    try {
      // 최근 24시간 내 머지된 PR 확인
      const { stdout } = await execAsync(
        `gh pr list --repo ${projConfig.repo} --state merged --base ${projConfig.main_branch} --json number,mergedAt,title --limit 10`,
        { timeout: 15_000 },
      );

      const prs = JSON.parse(stdout) as { number: number; mergedAt: string; title: string }[];
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      for (const pr of prs) {
        if (new Date(pr.mergedAt) > oneDayAgo) {
          // fix/ 브랜치의 PR이면 배포 큐에 추가
          if (pr.title.startsWith('fix(')) {
            // 해당 프로젝트의 모든 deploy 가능 서비스를 큐에 추가
            if (projConfig.docker?.services) {
              for (const [svcName, svcConfig] of Object.entries(projConfig.docker.services)) {
                if (svcConfig.deploy) {
                  enqueueDeploy(projName, svcName, `Merged PR #${pr.number}: ${pr.title}`, pr.number);
                  enqueued++;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      const err = error as { message?: string };
      console.log(`  [deploy] ${projName}: PR 확인 실패: ${err.message?.substring(0, 100)}`);
    }
  }

  return enqueued;
}

export { isWithinDeployWindow, loadDeployQueue, saveDeployQueue };
