/**
 * Docker Health Monitor (Phase 7)
 *
 * Docker 컨테이너 상태 점검, 로그 이상 감지, 리소스 모니터링을 수행합니다.
 * Tier 1 스케줄러에서 매 10분마다 호출됩니다.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import http from 'http';
import net from 'net';

import type {
  ProjectsConfig,
  ProjectConfig,
  DockerServiceConfig,
  DockerIssue,
  DockerIssueSeverity,
  SuggestedAction,
  ResourceSnapshot,
  ContainerState,
  ContainerStatus,
  ServiceCheckResult,
  MonitorResult,
  ScheduleConfig,
} from './types/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOG_DIR = resolve(__dirname, '..', 'logs');
const MONITOR_STATE_FILE = resolve(LOG_DIR, 'monitor-state.json');

/** 모니터 상태 (연속 실패 카운트 추적용) */
interface MonitorState {
  version: string;
  lastCheckAt: string;
  consecutiveFailures: Record<string, number>; // key: "project/service"
  recentIssues: DockerIssue[];
}

function loadMonitorState(): MonitorState {
  if (existsSync(MONITOR_STATE_FILE)) {
    return JSON.parse(readFileSync(MONITOR_STATE_FILE, 'utf-8'));
  }
  return {
    version: '1.0.0',
    lastCheckAt: '',
    consecutiveFailures: {},
    recentIssues: [],
  };
}

function saveMonitorState(state: MonitorState): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  // recentIssues를 최근 100건으로 제한
  state.recentIssues = state.recentIssues.slice(-100);
  writeFileSync(MONITOR_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function stateKey(project: string, service: string): string {
  return `${project}/${service}`;
}

/** 설정 파일 로드 (환경변수 치환 포함) */
function loadConfig<T>(relativePath: string): T {
  const fullPath = resolve(__dirname, '..', relativePath);
  let content = readFileSync(fullPath, 'utf-8');
  // ${HOME} 등 환경변수 치환
  content = content.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  return JSON.parse(content) as T;
}

/** 로컬 설정 오버라이드 적용 */
function loadProjectsConfig(): ProjectsConfig {
  const config = loadConfig<ProjectsConfig>('configs/projects.json');
  const localPath = resolve(__dirname, '..', 'configs', 'projects.local.json');
  if (existsSync(localPath)) {
    let localContent = readFileSync(localPath, 'utf-8');
    localContent = localContent.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
    const localConfig = JSON.parse(localContent) as { projects?: Record<string, Partial<ProjectConfig>> };
    if (localConfig.projects) {
      for (const [name, overrides] of Object.entries(localConfig.projects)) {
        if (config.projects[name]) {
          Object.assign(config.projects[name], overrides);
        }
      }
    }
  }
  return config;
}

// ===== Container Inspection =====

/**
 * docker ps로 컨테이너 상태를 조회합니다.
 */
async function getContainerState(containerName: string): Promise<ContainerState | null> {
  try {
    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Config.Image}}|{{range .NetworkSettings.Ports}}{{.}}{{end}}' ${containerName} 2>/dev/null`,
      { timeout: 10_000 },
    );

    const parts = stdout.trim().split('|');
    const statusRaw = parts[0] || 'unknown';
    const healthRaw = parts[1] || 'none';
    const restartCount = parseInt(parts[2] || '0', 10);
    const startedAt = parts[3] || '';
    const image = parts[4] || '';
    const ports = parts[5] || '';

    const statusMap: Record<string, ContainerStatus> = {
      running: 'running',
      exited: 'exited',
      restarting: 'restarting',
      paused: 'paused',
      dead: 'dead',
      created: 'stopped',
    };

    return {
      name: containerName,
      status: statusMap[statusRaw] ?? 'unknown',
      health: (healthRaw as ContainerState['health']) || 'none',
      restartCount,
      uptime: startedAt,
      image,
      ports,
    };
  } catch {
    return null;
  }
}

/**
 * docker stats로 리소스 사용량을 조회합니다.
 */
async function getResourceSnapshot(containerName: string): Promise<ResourceSnapshot | null> {
  try {
    const { stdout } = await execAsync(
      `docker stats --no-stream --format='{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}' ${containerName} 2>/dev/null`,
      { timeout: 15_000 },
    );

    const parts = stdout.trim().split('|');
    const cpuPercent = parseFloat(parts[0]?.replace('%', '') || '0');
    const memParts = (parts[1] || '0MiB / 0MiB').split('/').map((s) => s.trim());
    const memoryUsageMb = parseMemoryValue(memParts[0]);
    const memoryLimitMb = parseMemoryValue(memParts[1]);
    const memoryPercent = parseFloat(parts[2]?.replace('%', '') || '0');
    const netParts = (parts[3] || '0B / 0B').split('/').map((s) => s.trim());
    const blockParts = (parts[4] || '0B / 0B').split('/').map((s) => s.trim());

    return {
      cpuPercent,
      memoryUsageMb,
      memoryLimitMb,
      memoryPercent,
      networkRx: netParts[0] || '0B',
      networkTx: netParts[1] || '0B',
      blockRead: blockParts[0] || '0B',
      blockWrite: blockParts[1] || '0B',
    };
  } catch {
    return null;
  }
}

function parseMemoryValue(str: string): number {
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  if (str.includes('GiB')) return num * 1024;
  if (str.includes('MiB')) return num;
  if (str.includes('KiB')) return num / 1024;
  return num;
}

// ===== Health Checks =====

/**
 * HTTP health check를 수행합니다.
 */
function httpHealthCheck(
  endpoint: string,
  port: number,
  timeoutMs: number,
): Promise<{ passed: boolean; details: string }> {
  return new Promise((resolve) => {
    const url = `http://localhost:${port}${endpoint}`;
    const timer = setTimeout(() => {
      resolve({ passed: false, details: `Timeout after ${timeoutMs}ms: ${url}` });
    }, timeoutMs);

    const req = http.get(url, (res) => {
      clearTimeout(timer);
      const passed = (res.statusCode ?? 500) < 400;
      resolve({
        passed,
        details: `HTTP ${res.statusCode} from ${url}`,
      });
      res.resume();
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({ passed: false, details: `HTTP error: ${err.message} (${url})` });
    });
  });
}

/**
 * TCP health check를 수행합니다.
 */
function tcpHealthCheck(
  port: number,
  timeoutMs: number,
): Promise<{ passed: boolean; details: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ passed: false, details: `TCP timeout on port ${port}` });
    }, timeoutMs);

    socket.connect(port, 'localhost', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ passed: true, details: `TCP port ${port} open` });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ passed: false, details: `TCP error on port ${port}: ${err.message}` });
    });
  });
}

/**
 * docker exec 기반 health check를 수행합니다.
 */
async function execHealthCheck(
  containerName: string,
  command: string,
  timeoutMs: number,
): Promise<{ passed: boolean; details: string }> {
  try {
    const { stdout } = await execAsync(
      `docker exec ${containerName} ${command}`,
      { timeout: timeoutMs },
    );
    return { passed: true, details: stdout.trim().substring(0, 200) };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return {
      passed: false,
      details: `exec failed: ${(err.stderr || err.message || '').substring(0, 200)}`,
    };
  }
}

/**
 * 서비스 설정에 따라 health check를 수행합니다.
 */
async function performHealthCheck(
  serviceConfig: DockerServiceConfig,
): Promise<{ passed: boolean; details: string }> {
  const hc = serviceConfig.health_check;
  const timeoutMs = hc.timeout_seconds * 1000;

  switch (hc.type) {
    case 'http':
      return httpHealthCheck(hc.endpoint || '/', hc.port || 80, timeoutMs);
    case 'tcp':
      return tcpHealthCheck(hc.port || 80, timeoutMs);
    case 'exec':
      return execHealthCheck(
        serviceConfig.container_name,
        hc.command || 'true',
        timeoutMs,
      );
    default:
      return { passed: false, details: `Unknown health check type: ${hc.type}` };
  }
}

// ===== Log Analysis =====

/**
 * 컨테이너 로그에서 이상 패턴을 감지합니다.
 * 최근 10분(600초) 로그만 분석합니다.
 */
async function analyzeContainerLogs(
  containerName: string,
  logPatterns: { error: string[]; warning: string[] },
): Promise<{ severity: DockerIssueSeverity; matchedLines: string[] }[]> {
  const issues: { severity: DockerIssueSeverity; matchedLines: string[] }[] = [];

  try {
    const { stdout: logs } = await execAsync(
      `docker logs --since=10m ${containerName} 2>&1`,
      { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    );

    if (!logs.trim()) return issues;

    const lines = logs.split('\n');

    // Error 패턴 검사
    for (const pattern of logPatterns.error) {
      const regex = new RegExp(pattern, 'i');
      const matched = lines.filter((line) => regex.test(line));
      if (matched.length > 0) {
        issues.push({
          severity: 'critical',
          matchedLines: matched.slice(0, 5).map((l) => l.substring(0, 200)),
        });
      }
    }

    // Warning 패턴 검사
    for (const pattern of logPatterns.warning) {
      const regex = new RegExp(pattern, 'i');
      const matched = lines.filter((line) => regex.test(line));
      if (matched.length > 0) {
        issues.push({
          severity: 'warning',
          matchedLines: matched.slice(0, 3).map((l) => l.substring(0, 200)),
        });
      }
    }
  } catch {
    // 로그 분석 실패는 무시
  }

  return issues;
}

// ===== Resource Check =====

/**
 * 리소스 사용량이 임계값을 초과했는지 확인합니다.
 */
function checkResourceLimits(
  resource: ResourceSnapshot,
  limits: { cpu_percent: number; memory_mb: number; disk_percent: number },
): DockerIssue[] {
  const issues: DockerIssue[] = [];
  const now = new Date().toISOString();

  if (resource.cpuPercent > limits.cpu_percent) {
    issues.push({
      project: '',
      service: '',
      containerName: '',
      type: 'resource_exceeded',
      severity: resource.cpuPercent > 95 ? 'critical' : 'warning',
      details: `CPU ${resource.cpuPercent.toFixed(1)}% > limit ${limits.cpu_percent}%`,
      timestamp: now,
      suggestedAction: 'scale',
      resourceSnapshot: resource,
    });
  }

  if (resource.memoryUsageMb > limits.memory_mb) {
    issues.push({
      project: '',
      service: '',
      containerName: '',
      type: 'resource_exceeded',
      severity: resource.memoryPercent > 95 ? 'critical' : 'warning',
      details: `Memory ${resource.memoryUsageMb.toFixed(0)}MB > limit ${limits.memory_mb}MB`,
      timestamp: now,
      suggestedAction: resource.memoryPercent > 95 ? 'restart' : 'scale',
      resourceSnapshot: resource,
    });
  }

  return issues;
}

// ===== Critical Action: Auto-Restart =====

/**
 * Critical 상태의 컨테이너를 재시작합니다.
 */
async function restartContainer(containerName: string): Promise<boolean> {
  try {
    console.log(`  [restart] ${containerName} 재시작 시도...`);
    await execAsync(`docker restart ${containerName}`, { timeout: 60_000 });
    console.log(`  [restart] ${containerName} 재시작 완료`);
    return true;
  } catch (error) {
    const err = error as { message?: string };
    console.log(`  [restart] ${containerName} 재시작 실패: ${err.message}`);
    return false;
  }
}

// ===== Main Monitor Logic =====

/**
 * 단일 서비스를 점검합니다.
 */
async function checkService(
  project: string,
  serviceName: string,
  serviceConfig: DockerServiceConfig,
  monitorState: MonitorState,
  onCritical: string,
): Promise<ServiceCheckResult> {
  const key = stateKey(project, serviceName);
  const now = new Date().toISOString();
  const issues: DockerIssue[] = [];

  // 1. 컨테이너 상태 확인
  const containerState = await getContainerState(serviceConfig.container_name);

  if (!containerState) {
    const issue: DockerIssue = {
      project,
      service: serviceName,
      containerName: serviceConfig.container_name,
      type: 'container_stopped',
      severity: 'critical',
      details: `Container ${serviceConfig.container_name} not found or not running`,
      timestamp: now,
      suggestedAction: 'restart',
    };
    issues.push(issue);
    monitorState.consecutiveFailures[key] = (monitorState.consecutiveFailures[key] || 0) + 1;

    return {
      project,
      service: serviceName,
      containerName: serviceConfig.container_name,
      containerState: {
        name: serviceConfig.container_name,
        status: 'unknown',
        health: 'none',
        restartCount: 0,
        uptime: '',
        image: '',
        ports: '',
      },
      healthCheckPassed: false,
      healthCheckDetails: 'Container not found',
      issues,
      checkedAt: now,
    };
  }

  // 2. 재시작 횟수 확인 (비정상 재시작 감지)
  if (containerState.restartCount > 3) {
    issues.push({
      project,
      service: serviceName,
      containerName: serviceConfig.container_name,
      type: 'container_restart',
      severity: containerState.restartCount > 10 ? 'critical' : 'warning',
      details: `Container has restarted ${containerState.restartCount} times`,
      timestamp: now,
      suggestedAction: 'code_fix',
    });
  }

  // 3. Health check
  let healthCheckPassed = false;
  let healthCheckDetails = '';

  if (containerState.status === 'running') {
    const hcResult = await performHealthCheck(serviceConfig);
    healthCheckPassed = hcResult.passed;
    healthCheckDetails = hcResult.details;

    if (!healthCheckPassed) {
      monitorState.consecutiveFailures[key] = (monitorState.consecutiveFailures[key] || 0) + 1;
      const consecutive = monitorState.consecutiveFailures[key];

      if (consecutive >= serviceConfig.health_check.unhealthy_threshold) {
        const issue: DockerIssue = {
          project,
          service: serviceName,
          containerName: serviceConfig.container_name,
          type: 'health_check_failed',
          severity: 'critical',
          details: `Health check failed ${consecutive} consecutive times: ${healthCheckDetails}`,
          timestamp: now,
          suggestedAction: 'restart',
        };
        issues.push(issue);

        // Critical 시 자동 재시작
        if (onCritical === 'restart_and_alert') {
          const restarted = await restartContainer(serviceConfig.container_name);
          if (restarted) {
            monitorState.consecutiveFailures[key] = 0;
            issue.details += ' → auto-restarted';
          }
        }
      }
    } else {
      // 성공 시 연속 실패 카운트 초기화
      monitorState.consecutiveFailures[key] = 0;
    }
  } else {
    healthCheckDetails = `Container status: ${containerState.status}`;
    monitorState.consecutiveFailures[key] = (monitorState.consecutiveFailures[key] || 0) + 1;
  }

  // 4. 리소스 사용량 점검
  let resource: ResourceSnapshot | null = null;
  if (containerState.status === 'running') {
    resource = await getResourceSnapshot(serviceConfig.container_name);
    if (resource && serviceConfig.resource_limits) {
      const resourceIssues = checkResourceLimits(resource, serviceConfig.resource_limits);
      for (const ri of resourceIssues) {
        ri.project = project;
        ri.service = serviceName;
        ri.containerName = serviceConfig.container_name;
        issues.push(ri);
      }
    }
  }

  // 5. 로그 이상 감지
  if (containerState.status === 'running' && serviceConfig.log_patterns) {
    const logIssues = await analyzeContainerLogs(
      serviceConfig.container_name,
      serviceConfig.log_patterns,
    );
    for (const li of logIssues) {
      issues.push({
        project,
        service: serviceName,
        containerName: serviceConfig.container_name,
        type: 'log_anomaly',
        severity: li.severity,
        details: `Log anomaly detected: ${li.matchedLines[0]?.substring(0, 100)}`,
        timestamp: now,
        suggestedAction: li.severity === 'critical' ? 'code_fix' : 'manual',
        matchedLogs: li.matchedLines,
      });
    }
  }

  return {
    project,
    service: serviceName,
    containerName: serviceConfig.container_name,
    containerState,
    healthCheckPassed,
    healthCheckDetails,
    resource: resource ?? undefined,
    issues,
    checkedAt: now,
  };
}

/**
 * 전체 Docker 서비스를 모니터링합니다.
 */
export async function monitorAllServices(projectName?: string): Promise<MonitorResult> {
  const startTime = Date.now();
  const config = loadProjectsConfig();
  const scheduleConfig = loadConfig<ScheduleConfig>('configs/schedule.json');
  const monitorState = loadMonitorState();

  const targetProjects = projectName
    ? { [projectName]: config.projects[projectName] }
    : Object.fromEntries(
        Object.entries(config.projects).filter(([, cfg]) => cfg.enabled),
      );

  const allResults: ServiceCheckResult[] = [];
  const allIssues: DockerIssue[] = [];

  let totalServices = 0;
  let healthyServices = 0;

  for (const [projName, projConfig] of Object.entries(targetProjects)) {
    if (!projConfig?.docker?.services) {
      console.log(`  [monitor] ${projName}: docker 설정 없음, 건너뜀`);
      continue;
    }

    console.log(`\n[monitor] ${projName}`);
    console.log('-'.repeat(40));

    for (const [svcName, svcConfig] of Object.entries(projConfig.docker.services)) {
      totalServices++;
      console.log(`  Checking ${svcName} (${svcConfig.container_name})...`);

      const result = await checkService(
        projName,
        svcName,
        svcConfig,
        monitorState,
        scheduleConfig.tiers.monitor.on_critical,
      );

      allResults.push(result);
      allIssues.push(...result.issues);

      if (result.healthCheckPassed) {
        healthyServices++;
        console.log(`  ✓ ${svcName}: healthy`);
      } else {
        console.log(`  ✗ ${svcName}: ${result.healthCheckDetails}`);
      }

      if (result.resource) {
        console.log(`    CPU: ${result.resource.cpuPercent.toFixed(1)}%, Mem: ${result.resource.memoryUsageMb.toFixed(0)}MB`);
      }

      for (const issue of result.issues) {
        console.log(`    [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.details.substring(0, 80)}`);
      }
    }
  }

  // 상태 저장
  monitorState.lastCheckAt = new Date().toISOString();
  monitorState.recentIssues.push(...allIssues);
  saveMonitorState(monitorState);

  const result: MonitorResult = {
    timestamp: new Date().toISOString(),
    totalServices,
    healthyServices,
    unhealthyServices: totalServices - healthyServices,
    issues: allIssues,
    serviceResults: allResults,
    durationMs: Date.now() - startTime,
  };

  // 요약 출력
  console.log('\n' + '='.repeat(50));
  console.log('MONITOR SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Total: ${totalServices} services`);
  console.log(`  Healthy: ${healthyServices}`);
  console.log(`  Unhealthy: ${totalServices - healthyServices}`);
  console.log(`  Issues: ${allIssues.length}`);
  console.log(`  Duration: ${result.durationMs}ms`);

  if (allIssues.filter((i) => i.severity === 'critical').length > 0) {
    console.log(`  CRITICAL issues: ${allIssues.filter((i) => i.severity === 'critical').length}`);
  }

  return result;
}

// Exports for testing
export {
  loadProjectsConfig,
  getContainerState,
  getResourceSnapshot,
  performHealthCheck,
  analyzeContainerLogs,
  restartContainer,
  loadMonitorState,
  saveMonitorState,
};
