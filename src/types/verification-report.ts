import type { Priority } from './issue.js';

/** 파일 커버리지 수준 */
export type FileCoverage = 'full' | 'partial' | 'none';

/** 수정 방향성 일치도 */
export type FixDirectionMatch = 'aligned' | 'partial' | 'divergent';

/** 종합 판정 */
export type ComplianceScore = 'pass' | 'review_needed' | 'rework_needed';

/**
 * QA Agent 요청 vs 실제 수정 비교 리포트
 * FIX_VERIFICATION_STANDARD와 연동하여 QA Agent 검증 전 사전 분석 제공
 */
export interface FixComplianceReport {
  issueNumber: number;
  prNumber: number;
  priority: Priority;

  /** 1. 파일 커버리지: QA Agent가 지적한 파일 vs 실제 수정 파일 */
  requestedFiles: string[];
  actuallyModified: string[];
  fileCoverage: FileCoverage;

  /** 2. 수정 방향성: QA Agent의 권장 수정 의도와 일치하는지 */
  fixDirectionMatch: FixDirectionMatch;
  directionAnalysis: string;

  /** 3. fix_hint 준수 여부 */
  fixHintFollowed: boolean | null;
  fixHintNote: string;

  /** 4. 검증 기준 충족 추정 (meta.verification) */
  verificationCriteria: string | null;
  criteriaMetEstimate: 'likely' | 'uncertain' | 'unlikely';

  /** 5. 빌드/테스트 결과 요약 */
  buildPassed: boolean;
  testPassed: boolean;

  /** 6. 종합 판정 */
  overallScore: ComplianceScore;
  summary: string;

  /** 리포트 생성 시각 */
  generatedAt: string;
}

/**
 * QA Agent 검증 파이프라인 연동 데이터
 * FIX_VERIFICATION_STANDARD 5단계에 필요한 정보를 구조화
 */
export interface QaVerificationData {
  /** 1단계: 우선순위 */
  priority: Priority;
  /** 2단계: BUG 재현 테스트 패턴 - [BUG-#N] */
  bugTestPattern: string;
  /** 3단계: 연속 안정성 - 필요 연속 통과 횟수 */
  requiredConsecutivePasses: number;
  /** 4단계: PR 머지 필수 여부 */
  requirePrMerged: boolean;
  /** 5단계: 회귀 확인 필수 여부 */
  requireNoRegression: boolean;
}
