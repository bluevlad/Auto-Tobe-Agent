import type { Priority, IssueCategory, FixStrategy } from './issue.js';

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
