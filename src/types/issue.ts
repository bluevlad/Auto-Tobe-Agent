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
  | 'testing';

/** 수정 전략 타입 */
export type FixStrategy = 'claude-code-cli' | 'template-based';

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
  /** QA-AGENT-META (있는 경우) */
  meta?: QaAgentMeta;
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
}

/** 이슈 파싱 실패 결과 */
export interface IssueParseError {
  issueNumber: number;
  error: string;
  raw?: string;
}
