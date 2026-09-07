/** 이슈 우선순위 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

/** 이슈 카테고리 */
export type IssueCategory =
  | 'security'
  | 'performance'
  | 'architecture'
  | 'code-quality'
  | 'operations'
  | 'frontend'
  | 'testing'
  | 'tech-adoption';

/** 수정 전략 타입 */
export type FixStrategy = 'claude-code-cli' | 'template-based' | 'tech-adoption-template';

/** 이슈 출처 — Inspector 채널 식별 (라벨 source/* 기반) */
export type IssueSource = 'qa-agent' | 'tech-adoption';

/**
 * QA Agent W6 origin 트랙 — 라벨 `origin:*` 또는 QA-AGENT-META의 origin 필드.
 * 표준: Ai-Legacy-bluevlad/standards/qa/QA_ISSUE_TAXONOMY.md §2.1
 */
export type IssueOrigin =
  | 'qa-runtime'
  | 'qa-static'
  | 'qa-external-tech'
  | 'qa-rag-quality'
  | 'qa-improvement';

/**
 * fix 결과 등록 시 사용되는 분류 어휘 — Ai-Legacy-bluevlad/standards/qa/FIX_RESULT_REGISTRATION.md 와 동일 사전.
 */
export type FixSource = 'agent' | 'developer';

export type DiscoveryMethod =
  | 'scheduled_scan'
  | 'static_analysis'
  | 'health_check'
  | 'test_failure'
  | 'tech_adoption_proposal'
  | 'user_report'
  | 'log_review'
  | 'code_review'
  | 'monitoring_alert'
  | 'incident_postmortem'
  | 'manual_qa'
  | 'refactor_finding';

/**
 * QA-AGENT-META 구조화 메타데이터
 * QA Agent가 Issue 본문에 HTML 코멘트로 삽입하는 메타데이터
 *
 * 형식:
 * ```
 * <!-- QA-AGENT-META
 * { "project": "hopenvision", ... }
 * -->
 * ```
 */
/** 수정 대상 분류 */
export type FixCategory = 'service-code' | 'test-code' | 'unknown';

export interface QaAgentMeta {
  project: string;
  repo: string;
  priority: Priority;
  category: IssueCategory;
  files: string[];
  lines?: number[];
  auto_fixable: boolean;
  fix_hint?: string;
  verification?: string;
  /** QA Agent 실행 Run ID (점검→수정→확인 추적용) */
  runId?: string;
  /** 수정 대상 분류: service-code(백엔드), test-code(테스트), unknown */
  fix_category?: FixCategory;
  /** W6+ origin 트랙 (qa-runtime/qa-static/qa-external-tech/qa-rag-quality/qa-improvement) */
  origin?: IssueOrigin;
}

/** 변경 범위 — tech-adoption 자동 적용 시 화이트리스트로 사용 */
export type ChangeScope = 'deps-only' | 'config-only' | 'code-modifying';

/**
 * TECH-ADOPTION-META — medium-digest-agent가 발행하는 기술 도입 제안 이슈의 메타데이터.
 *
 * Issue body에 다음 형식으로 임베드:
 * ```
 * <!-- TECH-ADOPTION-META
 * { "techKeyword": "Spring Boot Actuator", ... }
 * -->
 * ```
 */
export interface TechAdoptionMeta {
  project: string;
  repo: string;
  priority: Priority;
  /** 기술 키워드 (예: "Spring Boot Actuator", "React Suspense") */
  techKeyword: string;
  /** 도입 난이도 */
  difficulty: 'low' | 'medium' | 'high';
  /** 기술 성숙도 */
  maturity: 'experimental' | 'mainstream' | 'standard';
  /** 대상 스택 — 에이전트 분기 필터 (hopenvision은 react만 처리) */
  stack: 'java' | 'react' | 'python' | 'mixed';
  /** 변경 범위 — code-modifying은 자동 적용 차단, deps-only/config-only만 자동 시도 */
  changeScope: ChangeScope;
  /** 변경 대상 파일 (예: ["pom.xml", "application.yml"]) */
  targetFiles: string[];
  /** 원본 digest 보고서 식별자 (예: "2026-04-14-spring-boot.md") */
  sourceReport: string;
  /** 본 보고서를 발행한 에이전트 (예: "medium-digest-agent") */
  proposedBy?: string;
}

/**
 * GitHub Issue에서 파싱된 구조화된 이슈 데이터
 */
export interface ParsedIssue {
  /** GitHub Issue 번호 */
  number: number;
  /** Issue 제목 */
  title: string;
  /** Issue 본문 (원본 마크다운) */
  body: string;
  /** Issue URL */
  url: string;
  /** 대상 리포지토리 (owner/repo) */
  repo: string;
  /** 라벨 목록 */
  labels: string[];
  /** 파싱된 우선순위 (라벨 또는 META에서 추출) */
  priority: Priority;
  /** 파싱된 카테고리 */
  category: IssueCategory;
  /** 이슈 출처 채널 — 라벨 source/* 또는 카테고리에서 결정 */
  source: IssueSource;
  /** W6+ origin 트랙 — 라벨 origin:* 우선, 없으면 QA-AGENT-META.origin (구형 이슈는 undefined) */
  origin?: IssueOrigin;
  /**
   * QA Agent 게이트 라벨 `auto-fix` 존재 여부 — Inspector가 자동 처리를 승인한 이슈
   * (service-bug + P2/P3만 부여). origin 라벨이 있는 신형 이슈에서만 게이트로 사용.
   */
  autoFixApproved: boolean;
  /** 게이트 라벨 `human-approval-required` 또는 origin이 사람 승인 필수 트랙인 경우 true */
  humanApprovalRequired: boolean;
  /** QA-AGENT-META (있는 경우) */
  meta?: QaAgentMeta;
  /** TECH-ADOPTION-META (source가 tech-adoption인 경우) */
  techAdoptionMeta?: TechAdoptionMeta;
  /** 본문에서 추출한 정보 (legacy 이슈 호환) */
  parsedContent: {
    problem: string;
    recommendation?: string;
    affectedFiles?: string[];
    codeSnippets?: string[];
  };
  /** QA Agent Run ID (점검→수정→확인 추적용) */
  sourceRunId?: string;
  /** 이슈 생성 시각 */
  createdAt: string;
  /** 수정 가능 여부 판단 */
  isAutoFixable: boolean;
  /** 중복 이슈 필터링용 정규화된 키 (제목에서 변동 부분 제거) */
  deduplicationKey?: string;
}

/** 이슈 파싱 실패 결과 */
export interface IssueParseError {
  issueNumber: number;
  error: string;
  raw?: string;
}
