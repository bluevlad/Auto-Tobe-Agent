/**
 * LLMOps batch_runs 보고용 클라이언트 (TypeScript).
 *
 * 표준: standards/observability/BATCH_RUN_REPORTING.md
 * - POST {LLMOPS_URL}/api/batch-runs (X-LLMOps-Key + X-Consumer-Id)
 * - fire-and-forget: 타임아웃 ≤ 1s, 예외 swallow, 비동기 발사 후 즉시 반환
 * - 재시도 금지 (관측 데이터 누락 허용)
 *
 * 의존성: Node 18+ 내장 fetch + AbortSignal.timeout.
 *
 * 사용 예 (단순):
 *     import { reportBatchRun } from './llmops/client.js';
 *
 *     reportBatchRun({
 *         consumerId: "medium-digest-agent",
 *         runId: `${new Date().toISOString()}-${process.pid}`,
 *         startedAt: started,
 *         endedAt: new Date(),
 *         status: "success",
 *         stages: [
 *             { name: "extract", model: "qwen2.5-coder:14b", durationMs: 12500 },
 *         ],
 *         metrics: { emailsProcessed: 5, reportsGenerated: 3 },
 *     });
 *
 * 사용 예 (재사용):
 *     const client = new LLMOpsClient({ consumerId: "medium-digest-agent" });
 *     client.report({ runId, startedAt, status: "success", stages, metrics });
 *
 * 환경변수:
 *     LLMOPS_URL=http://host.docker.internal:9110/api/batch-runs (또는 https://llmops.unmong.com/...)
 *     LLMOPS_API_KEY=<consumer 별 발급된 키>
 */

export type RunStatus = 'success' | 'failure' | 'partial';

export interface StageReport {
    name?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
}

export interface ReportInput {
    runId: string;
    startedAt: Date | string;
    status: RunStatus;
    endedAt?: Date | string | null;
    stages?: ReadonlyArray<StageReport>;
    metrics?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
    extra?: Record<string, unknown> | null;
}

export interface LLMOpsClientOptions {
    consumerId: string;
    url?: string;
    apiKey?: string;
    timeoutMs?: number;
    enabled?: boolean;
}

const DEFAULT_URL =
    process.env.LLMOPS_URL ?? 'http://host.docker.internal:9110/api/batch-runs';
const DEFAULT_TIMEOUT_MS = 1000;

// pending fire-and-forget promises 추적 — 짧게 끝나는 process 에서 flush() 로 await 가능.
const _PENDING: Set<Promise<unknown>> = new Set();

function toIso(value: Date | string): string {
    return typeof value === 'string' ? value : value.toISOString();
}

function camelToSnake<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const snake = k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
        out[snake] = v;
    }
    return out;
}

function buildPayload(consumerId: string, input: ReportInput): unknown {
    const stages = (input.stages ?? []).map((s) => camelToSnake(s as unknown as Record<string, unknown>));
    return camelToSnake({
        consumerId,
        runId: input.runId,
        startedAt: toIso(input.startedAt),
        endedAt: input.endedAt ? toIso(input.endedAt) : undefined,
        status: input.status,
        stages,
        metrics: input.metrics ?? undefined,
        error: input.error ?? undefined,
        extra: input.extra ?? undefined,
    });
}

export class LLMOpsClient {
    readonly consumerId: string;
    readonly url: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
    readonly enabled: boolean;

    constructor(opts: LLMOpsClientOptions) {
        this.consumerId = opts.consumerId;
        this.url = opts.url ?? DEFAULT_URL;
        this.apiKey = opts.apiKey ?? process.env.LLMOPS_API_KEY ?? '';
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.enabled = (opts.enabled ?? true) && Boolean(this.apiKey);
    }

    /** Fire-and-forget — 절대 예외 throw 하지 않음. await 해도 즉시 resolve. */
    report(input: ReportInput): void {
        if (!this.enabled) return;

        const body = JSON.stringify(buildPayload(this.consumerId, input));
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-LLMOps-Key': this.apiKey,
            'X-Consumer-Id': this.consumerId,
        };

        // 비동기 발사 — Promise 무시. 절대 throw 안 되도록 catch 로 끝맺음.
        const p = fetch(this.url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
        })
            .then((res) => res.text().then(() => undefined))
            .catch(() => undefined)
            .finally(() => {
                _PENDING.delete(p);
            });
        _PENDING.add(p);
    }

    /** 편의용 — 모듈 함수 flushPending() 과 동일. */
    static flush(timeoutMs = 2000): Promise<number> {
        return flushPending(timeoutMs);
    }
}

/**
 * 진행 중인 fire-and-forget Promise 들이 완료될 때까지 await.
 * 짧은 lifetime 의 process (배치 잡 등) 종료 직전 호출.
 *
 * Returns: 시간 내 완료된 promise 수.
 */
export async function flushPending(timeoutMs = 2000): Promise<number> {
    const pending = [...(_PENDING.values())];
    if (pending.length === 0) return 0;

    const settled = Promise.allSettled(pending);
    if (timeoutMs <= 0) {
        await settled;
        return pending.length;
    }
    const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), timeoutMs).unref?.(),
    );
    const result = await Promise.race([settled, timeout]);
    if (result === 'timeout') {
        return pending.length - _PENDING.size; // 완료된 개수
    }
    return pending.length;
}

/** 1회성 보고 — 내부에서 LLMOpsClient 1회 생성. */
export function reportBatchRun(
    input: ReportInput & { consumerId: string; url?: string; apiKey?: string; timeoutMs?: number },
): void {
    const { consumerId, url, apiKey, timeoutMs, ...rest } = input;
    new LLMOpsClient({ consumerId, url, apiKey, timeoutMs }).report(rest);
}
