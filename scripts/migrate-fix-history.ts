/**
 * 기존 fix-history.json 데이터를 QA-Dashboard DB로 마이그레이션
 *
 * 사용법: npx tsx scripts/migrate-fix-history.ts [--dry-run]
 *
 * GitHub Issue에서 누락 필드(priority, category, sourceRunId)를 보완하여
 * QA-Dashboard /api/fix-results 엔드포인트로 전송합니다.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- 설정 ---

interface DashboardConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
}

interface HistoryEntry {
  issueNumber: number;
  project: string;
  status: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  error?: string;
  processedAt: string;
  durationMs: number;
}

interface HistoryFile {
  version: string;
  lastRunAt: string;
  entries: Record<string, HistoryEntry>;
}

// GitHub Issue에서 보완한 메타데이터 (사전 조회 결과)
const ISSUE_METADATA: Record<number, {
  priority: string;
  category: string;
  sourceRunId: string | null;
  title: string;
  createdAt: string;
}> = {
  48: {
    priority: 'P1',
    category: 'security',
    sourceRunId: null,
    title: '[P1][security] Docker log anomaly: api (hopenvision-api)',
    createdAt: '2026-03-03T01:30:02Z',
  },
  49: {
    priority: 'P1',
    category: 'security',
    sourceRunId: null,
    title: '[P1][security] Docker log anomaly: api (hopenvision-api)',
    createdAt: '2026-03-03T01:30:03Z',
  },
  54: {
    priority: 'P0',
    category: 'operations',
    sourceRunId: '20260304-220003',
    title: '[QA-Improvement] hopenvision - 5일 연속 서비스 다운',
    createdAt: '2026-03-04T13:01:13Z',
  },
  59: {
    priority: 'P1',
    category: 'performance',
    sourceRunId: null,
    title: '[P1][performance] Docker resource exceeded: api (hopenvision-api)',
    createdAt: '2026-03-12T01:43:01Z',
  },
  61: {
    priority: 'P1',
    category: 'operations',
    sourceRunId: '20260312-220006',
    title: '[QA-Improvement] hopenvision - 3일 연속 서비스 다운',
    createdAt: '2026-03-12T13:07:23Z',
  },
};

function loadConfig(): DashboardConfig {
  const envUrl = process.env['QA_DASHBOARD_API_URL'];
  const envKey = process.env['QA_DASHBOARD_API_KEY'];

  if (envUrl && envKey) {
    return { enabled: true, apiUrl: envUrl, apiKey: envKey, timeoutMs: 10000 };
  }

  const configPath = resolve(__dirname, '..', 'configs', 'dashboard.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as DashboardConfig;
  } catch {
    throw new Error('Dashboard config not found. Set QA_DASHBOARD_API_URL and QA_DASHBOARD_API_KEY');
  }
}

function buildPayload(entry: HistoryEntry) {
  const meta = ISSUE_METADATA[entry.issueNumber];

  // processedAt에서 startedAt 역산 (processedAt - durationMs)
  const completedAt = entry.processedAt;
  const startedAt = meta?.createdAt
    ? new Date(new Date(completedAt).getTime() - entry.durationMs).toISOString()
    : completedAt;

  return {
    issueNumber: entry.issueNumber,
    projectName: entry.project,
    sourceRunId: meta?.sourceRunId ?? null,
    priority: meta?.priority ?? 'P3',
    category: meta?.category ?? 'code-quality',
    strategy: 'claude-code-cli',
    status: entry.status,
    branchName: entry.branchName ?? null,
    commitHash: null,
    prUrl: entry.prUrl ?? null,
    prNumber: entry.prNumber ?? null,
    modifiedFiles: [],
    verifications: [],
    complianceScore: null,
    error: entry.error ?? null,
    retryCount: 0,
    durationMs: entry.durationMs,
    startedAt,
    completedAt,
  };
}

async function sendToApi(config: DashboardConfig, payload: Record<string, unknown>): Promise<boolean> {
  const url = config.apiUrl.replace(/\/+$/, '') + '/fix-results';
  const apiKey = config.apiKey.startsWith('${')
    ? process.env['QA_DASHBOARD_API_KEY'] ?? ''
    : config.apiKey;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`  HTTP ${response.status}: ${body}`);
      return false;
    }
    return true;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const historyPath = resolve(__dirname, '..', 'logs', 'fix-history.json');

  console.log('=== Fix History → QA-Dashboard Migration ===\n');

  // 1. Load history
  const history: HistoryFile = JSON.parse(readFileSync(historyPath, 'utf-8'));
  const entries = Object.values(history.entries);
  console.log(`Found ${entries.length} entries in fix-history.json\n`);

  // 2. Load config
  let config: DashboardConfig | null = null;
  if (!dryRun) {
    config = loadConfig();
    console.log(`Dashboard API: ${config.apiUrl}\n`);
  }

  // 3. Process each entry
  let sent = 0;
  let failed = 0;

  for (const entry of entries) {
    const meta = ISSUE_METADATA[entry.issueNumber];
    const payload = buildPayload(entry);

    console.log(`[#${entry.issueNumber}] ${meta?.title ?? entry.project}`);
    console.log(`  Priority: ${payload.priority}, Category: ${payload.category}`);
    console.log(`  Status: ${payload.status}, RunId: ${payload.sourceRunId ?? '(없음)'}`);
    console.log(`  Duration: ${(entry.durationMs / 1000).toFixed(0)}s`);

    if (dryRun) {
      console.log('  → [DRY-RUN] Would send to Dashboard');
      console.log(`  Payload: ${JSON.stringify(payload, null, 2).split('\n').map(l => '    ' + l).join('\n')}`);
    } else {
      try {
        const ok = await sendToApi(config!, payload);
        if (ok) {
          console.log('  → Sent to Dashboard ✓');
          sent++;
        } else {
          console.log('  → Failed to send ✗');
          failed++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  → Error: ${msg}`);
        failed++;
      }
    }
    console.log();
  }

  // 4. Summary
  console.log('--- Summary ---');
  console.log(`Total: ${entries.length}, Sent: ${sent}, Failed: ${failed}`);
  if (dryRun) console.log('(Dry-run mode — no data was sent)');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
