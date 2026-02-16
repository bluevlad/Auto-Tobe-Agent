import type { Priority, FixStrategy } from './issue.js';

/** 알림 설정 */
export interface NotificationConfig {
  on_fix_created: boolean;
  on_pr_created: boolean;
  on_verification_complete: boolean;
  channels: string[];
}

/** 자동 머지 조건 */
export interface MergeConditions {
  all_checks_passed: boolean;
  no_regression: boolean;
}

/** 단일 우선순위 정책 */
export interface PriorityPolicy {
  description: string;
  auto_fix: boolean;
  auto_pr: boolean;
  auto_merge: boolean;
  auto_deploy: boolean;
  required_reviewers: string[];
  conditions?: MergeConditions;
  fix_strategy: FixStrategy;
  max_retry: number;
  timeout_minutes: number;
  notification: NotificationConfig;
}

/** 전역 규칙 */
export interface GlobalRules {
  max_concurrent_fixes: number;
  branch_prefix: string;
  pr_template: string;
  require_clean_build: boolean;
  require_existing_tests_pass: boolean;
}

/** 전체 승인 정책 */
export interface ApprovalPolicyConfig {
  version: string;
  default_reviewers: string[];
  policies: Record<Priority, PriorityPolicy>;
  global_rules: GlobalRules;
}
