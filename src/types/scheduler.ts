import type { Priority } from './issue.js';
import type { FixResult } from './fix-result.js';

// ===== Round-Robin Scheduler Types =====

/** 영속 상태: 다음 배치에서 이어서 로테이션하기 위한 상태 */
export interface RoundRobinState {
  /** 마지막으로 처리한 서비스 인덱스 */
  lastServiceIndex: number;
  /** 배치별 프로젝트 쿼터 사용량 */
  batchQuota: Record<string, number>;
  /** 마지막 실행 시각 */
  lastRunAt: string;
  /** 마지막 배치에서 처리한 총 이슈 수 */
  lastBatchTotal: number;
}

/** 프로젝트별 이슈 큐 */
export interface ServiceWorkQueue {
  /** 프로젝트명 */
  project: string;
  /** 처리 대상 이슈 목록 (우선순위순 정렬) */
  issues: Array<{
    issueNumber: number;
    priority: Priority;
    title: string;
  }>;
  /** 이 배치에서 소비한 이슈 수 */
  consumed: number;
  /** 최대 허용 이슈 수 (max_issues_per_service) */
  maxQuota: number;
}

/** 실행 계획의 단위 작업 */
export interface PlannedWorkItem {
  /** 실행 순서 (0-based) */
  order: number;
  /** 프로젝트명 */
  project: string;
  /** 이슈 번호 */
  issueNumber: number;
  /** 이슈 우선순위 */
  priority: Priority;
  /** 이슈 제목 */
  title: string;
}

/** 전체 배치 실행 계획 */
export interface BatchPlan {
  /** 계획 생성 시각 */
  createdAt: string;
  /** 인터리빙된 실행 순서 */
  items: PlannedWorkItem[];
  /** 프로젝트별 큐 상태 */
  queues: ServiceWorkQueue[];
  /** 총 대상 프로젝트 수 */
  totalProjects: number;
  /** 시작 서비스 인덱스 (이전 배치에서 이어받음) */
  startIndex: number;
}

/** Round-Robin 배치 실행 결과 요약 */
export interface RoundRobinBatchResult {
  /** 실행 시작 시각 */
  startedAt: string;
  /** 실행 완료 시각 */
  completedAt: string;
  /** 총 소요 시간 (ms) */
  totalDurationMs: number;
  /** 처리된 이슈 수 */
  totalProcessed: number;
  /** 성공 수 */
  succeeded: number;
  /** 실패 수 */
  failed: number;
  /** 건너뛴 수 */
  skipped: number;
  /** 시간 예산 초과로 조기 종료되었는지 */
  timedOut: boolean;
  /** 프로젝트별 처리 수 */
  perProject: Record<string, { processed: number; succeeded: number; failed: number }>;
  /** 개별 수정 결과 */
  results: FixResult[];
}

/** 스케줄 자동 조정 권고 */
export interface ScheduleAdjustment {
  /** 권고 사유 */
  reason: string;
  /** 현재 서비스 수 */
  currentServiceCount: number;
  /** 조정 임계값 */
  threshold: number;
  /** 현재 배치 스케줄 시간 */
  currentScheduleHours: number[];
  /** 권고 배치 스케줄 시간 */
  recommendedScheduleHours: number[];
}
