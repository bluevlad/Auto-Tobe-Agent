/**
 * Dashboard Reporter - 수정 결과를 QA-Dashboard API로 전송
 *
 * fix-history.json 로컬 저장과 병행하여 QA-Dashboard DB에도
 * 수정 결과를 기록하여 점검→수정→확인 추적을 가능하게 합니다.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { FixResult } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Dashboard 연동 설정 */
export interface DashboardConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** 전송 실패 시 로컬 큐에 저장할 항목 */
interface PendingReport {
  payload: Record<string, unknown>;
  failedAt: string;
  retryCount: number;
}

const QUEUE_DIR = resolve(__dirname, '..', 'logs');
const QUEUE_FILE = resolve(QUEUE_DIR, 'dashboard-queue.json');

/**
 * Dashboard 설정을 로드합니다.
 * configs/dashboard.json 또는 환경변수에서 읽습니다.
 */
export function loadDashboardConfig(): DashboardConfig {
  // 환경변수 우선
  const envUrl = process.env['QA_DASHBOARD_API_URL'];
  const envKey = process.env['QA_DASHBOARD_API_KEY'];

  if (envUrl && envKey) {
    return {
      enabled: true,
      apiUrl: envUrl,
      apiKey: envKey,
      timeoutMs: 10000,
    };
  }

  // configs/dashboard.json 파일 시도
  const configPath = resolve(__dirname, '..', 'configs', 'dashboard.json');
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as DashboardConfig;
  }

  return {
    enabled: false,
    apiUrl: '',
    apiKey: '',
    timeoutMs: 10000,
  };
}

/**
 * FixResult를 Dashboard API 페이로드로 변환합니다.
 */
function toPayload(result: FixResult): Record<string, unknown> {
  return {
    issueNumber: result.issueNumber,
    projectName: result.project,
    sourceRunId: null,
    priority: result.priority,
    category: result.category,
    strategy: result.strategy,
    status: result.status,
    branchName: result.branchName ?? null,
    commitHash: result.commitHash ?? null,
    prUrl: result.prUrl ?? null,
    prNumber: result.prNumber ?? null,
    modifiedFiles: result.modifiedFiles.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      linesAdded: f.linesAdded,
      linesDeleted: f.linesDeleted,
    })),
    verifications: result.verifications.map((v) => ({
      type: v.type,
      passed: v.passed,
      command: v.command,
      output: v.output ?? null,
      error: v.error ?? null,
      durationMs: v.durationMs,
    })),
    complianceScore: null,
    error: result.error ?? null,
    retryCount: result.retryCount,
    durationMs: result.durationMs ?? null,
    startedAt: result.startedAt,
    completedAt: result.completedAt ?? null,
  };
}

/**
 * 수정 결과를 QA-Dashboard API로 전송합니다.
 * 실패 시 로컬 큐에 저장하여 다음 배치에서 재전송합니다.
 */
export async function reportToDashboard(result: FixResult): Promise<boolean> {
  const config = loadDashboardConfig();

  if (!config.enabled) {
    return false;
  }

  const payload = toPayload(result);

  try {
    const success = await sendToDashboard(config, payload);
    if (success) {
      console.log(`  [dashboard] #${result.issueNumber} reported to dashboard`);
    }
    return success;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  [dashboard] Failed to report #${result.issueNumber}: ${msg}`);
    enqueuePending(payload);
    return false;
  }
}

/**
 * Dashboard API에 HTTP POST 요청을 보냅니다.
 */
async function sendToDashboard(
  config: DashboardConfig,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const url = config.apiUrl.replace(/\/+$/, '') + '/fix-results';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    return true;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 전송 실패한 항목을 로컬 큐에 저장합니다.
 */
function enqueuePending(payload: Record<string, unknown>): void {
  const queue = loadQueue();
  queue.push({
    payload,
    failedAt: new Date().toISOString(),
    retryCount: 0,
  });
  saveQueue(queue);
}

/**
 * 로컬 큐에 저장된 실패 항목들을 재전송합니다.
 * 배치 실행 시작 시 호출됩니다.
 */
export async function flushPendingReports(): Promise<{ sent: number; failed: number }> {
  const config = loadDashboardConfig();
  if (!config.enabled) return { sent: 0, failed: 0 };

  const queue = loadQueue();
  if (queue.length === 0) return { sent: 0, failed: 0 };

  console.log(`  [dashboard] Flushing ${queue.length} pending reports...`);

  const remaining: PendingReport[] = [];
  let sent = 0;

  for (const item of queue) {
    if (item.retryCount >= 3) {
      // 3회 초과 실패 시 폐기
      console.log(`  [dashboard] Discarding report after 3 retries`);
      continue;
    }

    try {
      const success = await sendToDashboard(config, item.payload);
      if (success) {
        sent++;
      } else {
        item.retryCount++;
        remaining.push(item);
      }
    } catch {
      item.retryCount++;
      remaining.push(item);
    }
  }

  saveQueue(remaining);
  return { sent, failed: remaining.length };
}

function loadQueue(): PendingReport[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf-8')) as PendingReport[];
  } catch {
    return [];
  }
}

function saveQueue(queue: PendingReport[]): void {
  if (!existsSync(QUEUE_DIR)) {
    mkdirSync(QUEUE_DIR, { recursive: true });
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}
