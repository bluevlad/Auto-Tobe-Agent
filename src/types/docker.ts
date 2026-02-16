import type { Priority } from './issue.js';

// ===== Docker Service Configuration =====

/** Health check 방식 */
export type HealthCheckType = 'http' | 'tcp' | 'exec';

/** Health check 설정 */
export interface HealthCheckConfig {
  type: HealthCheckType;
  /** HTTP 엔드포인트 (type: 'http') */
  endpoint?: string;
  /** 대상 포트 (type: 'http' | 'tcp') */
  port?: number;
  /** 실행 명령어 (type: 'exec') */
  command?: string;
  /** 점검 주기 (초) */
  interval_seconds: number;
  /** 타임아웃 (초) */
  timeout_seconds: number;
  /** healthy 판정 연속 성공 횟수 */
  healthy_threshold: number;
  /** unhealthy 판정 연속 실패 횟수 */
  unhealthy_threshold: number;
}

/** 로그 이상 감지 패턴 */
export interface LogPatterns {
  error: string[];
  warning: string[];
}

/** 리소스 사용량 임계값 */
export interface ResourceLimits {
  cpu_percent: number;
  memory_mb: number;
  disk_percent: number;
}

/** Docker 배포 설정 */
export interface DeployConfig {
  build_context: string;
  dockerfile?: string;
  rollback_on_failure: boolean;
  health_wait_seconds: number;
}

/** 단일 Docker 서비스 설정 */
export interface DockerServiceConfig {
  container_name: string;
  health_check: HealthCheckConfig;
  log_patterns?: LogPatterns;
  resource_limits?: ResourceLimits;
  deploy?: DeployConfig;
}

/** 프로젝트의 Docker 설정 */
export interface DockerConfig {
  compose_file: string;
  services: Record<string, DockerServiceConfig>;
}

// ===== Docker Monitoring Results =====

/** Docker 이슈 유형 */
export type DockerIssueType =
  | 'health_check_failed'
  | 'log_anomaly'
  | 'resource_exceeded'
  | 'container_restart'
  | 'container_stopped';

/** Docker 이슈 심각도 */
export type DockerIssueSeverity = 'critical' | 'warning' | 'info';

/** 권장 조치 */
export type SuggestedAction =
  | 'restart'
  | 'scale'
  | 'code_fix'
  | 'config_change'
  | 'manual'
  | 'none';

/** Docker 모니터링에서 감지된 이슈 */
export interface DockerIssue {
  /** 프로젝트명 */
  project: string;
  /** 서비스명 (docker compose service key) */
  service: string;
  /** 컨테이너명 */
  containerName: string;
  /** 이슈 유형 */
  type: DockerIssueType;
  /** 심각도 */
  severity: DockerIssueSeverity;
  /** 상세 내용 */
  details: string;
  /** 감지 시각 */
  timestamp: string;
  /** 권장 조치 */
  suggestedAction: SuggestedAction;
  /** 매칭된 로그 라인 (log_anomaly인 경우) */
  matchedLogs?: string[];
  /** 리소스 사용량 스냅샷 */
  resourceSnapshot?: ResourceSnapshot;
}

/** 리소스 사용량 스냅샷 */
export interface ResourceSnapshot {
  cpuPercent: number;
  memoryUsageMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
  networkRx: string;
  networkTx: string;
  blockRead: string;
  blockWrite: string;
}

/** 컨테이너 상태 */
export type ContainerStatus =
  | 'running'
  | 'stopped'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'dead'
  | 'unknown';

/** 컨테이너 상태 정보 */
export interface ContainerState {
  name: string;
  status: ContainerStatus;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  restartCount: number;
  uptime: string;
  image: string;
  ports: string;
}

/** 단일 서비스 점검 결과 */
export interface ServiceCheckResult {
  project: string;
  service: string;
  containerName: string;
  containerState: ContainerState;
  healthCheckPassed: boolean;
  healthCheckDetails?: string;
  resource?: ResourceSnapshot;
  issues: DockerIssue[];
  checkedAt: string;
}

/** 전체 모니터링 결과 */
export interface MonitorResult {
  timestamp: string;
  totalServices: number;
  healthyServices: number;
  unhealthyServices: number;
  issues: DockerIssue[];
  serviceResults: ServiceCheckResult[];
  durationMs: number;
}

// ===== Docker Deploy =====

/** 배포 상태 */
export type DeployStatus =
  | 'pending'
  | 'building'
  | 'deploying'
  | 'health_checking'
  | 'completed'
  | 'rolled_back'
  | 'failed';

/** 배포 결과 */
export interface DeployResult {
  project: string;
  service: string;
  status: DeployStatus;
  previousImage?: string;
  newImage?: string;
  buildDurationMs?: number;
  deployDurationMs?: number;
  healthCheckPassed?: boolean;
  rolledBack: boolean;
  error?: string;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
}

/** 배치 배포 결과 */
export interface BatchDeployResult {
  project: string;
  results: DeployResult[];
  totalDurationMs: number;
  allSucceeded: boolean;
  startedAt: string;
  completedAt: string;
}

// ===== Schedule Configuration =====

/** 모니터링 Tier 설정 */
export interface MonitorTierConfig {
  enabled: boolean;
  interval_minutes: number;
  max_duration_seconds: number;
  on_critical: 'restart_and_alert' | 'alert_only' | 'log_only';
  on_warning: 'log_and_create_issue' | 'log_only';
  alert_channels: string[];
}

/** 이슈 수정 Tier 설정 */
export interface FixTierConfig {
  enabled: boolean;
  schedule_hours: number[];
  max_duration_minutes: number;
  max_issues_per_service: number;
  round_robin: boolean;
  priority_order: Priority[];
  cooldown_between_fixes_seconds: number;
}

/** 배포 Tier 설정 */
export interface DeployTierConfig {
  enabled: boolean;
  trigger: 'on_merge_or_batch' | 'batch_only' | 'manual';
  allowed_hours: { start: number; end: number };
  deploy_order: string[];
  health_check_timeout_seconds: number;
  auto_rollback: boolean;
  require_approval_for: Priority[];
}

/** 스케일링 설정 */
export interface ScalingConfig {
  auto_adjust_schedule: boolean;
  max_services: number;
  add_batch_run_at_services: number;
  extra_schedule_hours: number[];
}

/** 전체 스케줄 설정 */
export interface ScheduleConfig {
  version: string;
  tiers: {
    monitor: MonitorTierConfig;
    fix: FixTierConfig;
    deploy: DeployTierConfig;
  };
  scaling: ScalingConfig;
}
