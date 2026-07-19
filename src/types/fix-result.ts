import type { Priority, IssueCategory, FixStrategy, IssueOrigin } from './issue.js';

/** 수정 상태 */
export type FixStatus =
  | 'pending'
  | 'in_progress'
  | 'fix_applied'
  | 'build_verified'
  | 'test_verified'
  | 'build_failed_ci_pending'
  | 'pr_created'
  | 'verification_requested'
  | 'verification_passed'
  | 'verification_failed'
  | 'merged'
  | 'deployed'
  | 'failed'
  | 'skipped';

/** 수정된 파일 정보 */
export interface ModifiedFile {
  path: string;
  changeType: 'modified' | 'added' | 'deleted';
  linesAdded: number;
  linesDeleted: number;
}

/** 빌드/테스트 검증 결과 */
export interface VerificationResult {
  type: 'build' | 'test' | 'lint';
  passed: boolean;
  command: string;
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * Claude Code CLI가 수정 완료 후 출력하는 FIX-REPORT 구조화 블록.
 * commit footer(ERROR_TAXONOMY 표준) 자동 생성에 사용 —
 * 대상 repo의 register-fix-to-dashboard.yml 워크플로가 footer를 파싱한다.
 */
export interface FixReport {
  /** 수정 요약 한 줄 */
  summary?: string;
  /** Root-Cause 분류 (예: import-error, async-handling, type-mismatch) */
  rootCause?: string;
  /** Error-Category 분류 (예: logic-error, compat-issue, config-error) */
  errorCategory?: string;
  /** Affected-Layer (예: backend/api, frontend/component) */
  affectedLayer?: string;
  /** 재발 방지책 한 줄 */
  prevention?: string;
}

/** 파일 수준 충돌 감지 결과 */
export interface FileConflictInfo {
  conflictingFiles: string[];
  conflictingPRs: Array<{ number: number; title: string }>;
}

/** 단일 이슈 수정 결과 */
export interface FixResult {
  issueNumber: number;
  project: string;
  repo: string;
  priority: Priority;
  category: IssueCategory;
  strategy: FixStrategy;
  status: FixStatus;
  branchName?: string;
  modifiedFiles: ModifiedFile[];
  commitHash?: string;
  prUrl?: string;
  prNumber?: number;
  verifications: VerificationResult[];
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  /** 파일 수준 충돌 감지 결과 (열린 PR과 겹치는 파일) */
  fileConflicts?: FileConflictInfo;
  /** QA Agent Run ID — 점검→수정→확인 lifecycle 추적용 */
  sourceRunId?: string;
  /** 중복 이슈 필터링용 정규화된 키 */
  deduplicationKey?: string;
  /** W6+ origin 트랙 — PR 라벨/draft 분기용 */
  origin?: IssueOrigin;
  /** 사람 승인 필수 이슈 — PR을 draft + needs-human-review로 생성 */
  humanApprovalRequired?: boolean;
  /** CLI 출력에서 파싱한 FIX-REPORT (commit footer 생성에 사용) */
  fixReport?: FixReport;
}

/** Pre-flight 충돌 검증 결과 */
export interface ConflictCheckResult {
  safe: boolean;
  reason?: string;
  action: 'proceed' | 'skip' | 'defer';
  activeBranch?: string;
  recentCommitCount?: number;
}

/** 배치 수정 결과 */
export interface BatchFixResult {
  totalIssues: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: FixResult[];
  startedAt: string;
  completedAt: string;
}
