import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { FixResult } from './types/index.js';
import { reportToDashboard } from './dashboard-reporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 처리 이력 항목 */
export interface FixHistoryEntry {
  issueNumber: number;
  project: string;
  status: FixResult['status'];
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  processedAt: string;
  durationMs?: number;
  /** 중복 이슈 필터링용 정규화된 키 (제목에서 변동 부분 제거) */
  deduplicationKey?: string;
}

/** 프로젝트별 처리 이력 */
export interface FixHistoryFile {
  version: string;
  lastRunAt: string;
  entries: Record<string, FixHistoryEntry>; // key: "{project}#{issueNumber}"
}

const HISTORY_DIR = resolve(__dirname, '..', 'logs');
const HISTORY_FILE = resolve(HISTORY_DIR, 'fix-history.json');

/**
 * 이력 파일을 로드합니다. 없으면 빈 이력을 반환합니다.
 */
export function loadHistory(): FixHistoryFile {
  if (!existsSync(HISTORY_FILE)) {
    return {
      version: '1.0.0',
      lastRunAt: '',
      entries: {},
    };
  }

  const content = readFileSync(HISTORY_FILE, 'utf-8');
  return JSON.parse(content) as FixHistoryFile;
}

/**
 * 이력 파일을 저장합니다.
 */
export function saveHistory(history: FixHistoryFile): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * 이력 키를 생성합니다.
 */
function historyKey(project: string, issueNumber: number): string {
  return `${project}#${issueNumber}`;
}

/**
 * 이슈가 이미 성공적으로 처리되었는지 확인합니다.
 * pr_created, merged, deployed 상태면 이미 처리된 것으로 판단합니다.
 */
export function isAlreadyProcessed(
  history: FixHistoryFile,
  project: string,
  issueNumber: number,
): boolean {
  const key = historyKey(project, issueNumber);
  const entry = history.entries[key];

  if (!entry) return false;

  const successStatuses = ['pr_created', 'merged', 'deployed', 'test_verified', 'build_verified', 'build_failed_ci_pending'];
  return successStatuses.includes(entry.status);
}

/**
 * FixResult를 이력에 기록하고, Dashboard API로도 전송합니다.
 * Dashboard 전송 실패는 로컬 이력 기록에 영향을 주지 않습니다.
 */
export function recordResult(
  history: FixHistoryFile,
  result: FixResult,
): void {
  const key = historyKey(result.project, result.issueNumber);
  history.entries[key] = {
    issueNumber: result.issueNumber,
    project: result.project,
    status: result.status,
    branchName: result.branchName,
    prUrl: result.prUrl,
    prNumber: result.prNumber,
    error: result.error,
    processedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    deduplicationKey: result.deduplicationKey,
  };
  history.lastRunAt = new Date().toISOString();

  // Dashboard API 비동기 전송 (실패해도 로컬 이력은 유지)
  reportToDashboard(result).catch(() => {
    // 전송 실패는 dashboard-reporter 내부에서 큐에 저장됨
  });
}

/**
 * 실패한 이력을 초기화하여 재시도할 수 있게 합니다.
 */
export function resetFailedEntry(
  history: FixHistoryFile,
  project: string,
  issueNumber: number,
): boolean {
  const key = historyKey(project, issueNumber);
  const entry = history.entries[key];

  if (entry && entry.status === 'failed') {
    delete history.entries[key];
    return true;
  }

  return false;
}

/**
 * 프로젝트의 모든 실패 이력을 초기화합니다.
 * 반환값: 삭제된 엔트리 수
 */
export function resetAllFailed(
  history: FixHistoryFile,
  project?: string,
): number {
  let count = 0;
  for (const [key, entry] of Object.entries(history.entries)) {
    if (entry.status === 'failed') {
      if (!project || entry.project === project) {
        delete history.entries[key];
        count++;
      }
    }
  }
  return count;
}

/**
 * 정규화된 키로 이미 처리된 이슈가 있는지 확인합니다 (중복 이슈 필터링).
 *
 * QA Agent가 동일 테스트 실패를 매번 새 이슈(다른 번호)로 생성할 때,
 * 제목 기반 partial match로 이미 처리된 동일 문제인지 판별합니다.
 */
export function isDuplicateByKey(
  history: FixHistoryFile,
  project: string,
  deduplicationKey: string,
): { isDuplicate: boolean; existingIssueNumber?: number } {
  if (!deduplicationKey) return { isDuplicate: false };

  const successStatuses = ['pr_created', 'merged', 'deployed', 'test_verified', 'build_verified', 'build_failed_ci_pending'];

  for (const [key, entry] of Object.entries(history.entries)) {
    if (!key.startsWith(`${project}#`)) continue;
    if (!successStatuses.includes(entry.status)) continue;

    // deduplicationKey를 이력의 deduplicationKey와 비교
    if (entry.deduplicationKey && entry.deduplicationKey === deduplicationKey) {
      return { isDuplicate: true, existingIssueNumber: entry.issueNumber };
    }
  }

  return { isDuplicate: false };
}

/**
 * 프로젝트의 처리 이력 통계를 반환합니다.
 */
export function getProjectStats(
  history: FixHistoryFile,
  project: string,
): { total: number; succeeded: number; failed: number; skipped: number } {
  const entries = Object.values(history.entries).filter(
    (e) => e.project === project,
  );

  const successStatuses = ['pr_created', 'merged', 'deployed', 'test_verified', 'build_verified', 'build_failed_ci_pending'];

  return {
    total: entries.length,
    succeeded: entries.filter((e) => successStatuses.includes(e.status)).length,
    failed: entries.filter((e) => e.status === 'failed').length,
    skipped: entries.filter((e) => e.status === 'skipped').length,
  };
}
