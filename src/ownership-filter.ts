/**
 * 이슈 소유권 필터 — "이 에이전트가 이 이슈를 수정해야 하는가?"를 판단합니다.
 *
 * 배경: 한 리포지토리를 여러 에이전트(React/Java)가 나눠 처리하는 경우,
 * 각 에이전트가 ProjectConfig.scope로 자신의 범위를 선언하고
 * 이 필터로 소유권이 없는 이슈를 조기에 건너뜁니다.
 *
 * 판단 순서 (옵션 C: 하이브리드):
 *   1. 라벨 (agent:frontend / agent:java-backend)  — 가장 신뢰도 높음
 *   2. 파일 경로 휴리스틱 (frontend_root / backend_root, .java 확장자)
 *   3. 카테고리 (issue.category === 'frontend')
 *   4. 우선순위 fallback — 판단 불가 시 P0/P1은 보류(hold-for-review), P2/P3는 skip
 */

import type { ParsedIssue, ResolvedProject, ProjectScope } from './types/index.js';

/** 프론트엔드 에이전트가 소유권을 주장하는 라벨 */
export const FRONTEND_AGENT_LABEL = 'agent:frontend';

/** 백엔드 에이전트가 소유권을 주장하는 라벨 (둘 다 "백엔드 담당") */
export const BACKEND_AGENT_LABELS = ['agent:java-backend', 'agent:backend'];

export type OwnershipAction = 'accept' | 'skip' | 'hold-for-review';

export interface OwnershipDecision {
  action: OwnershipAction;
  reason: string;
  /** 판단 근거: label | path | category | priority-fallback | scope-default */
  basis: 'label' | 'path' | 'category' | 'priority-fallback' | 'scope-default';
}

const BACKEND_FILE_EXTENSIONS = ['.java', '.kt', '.groovy'];

function hasBackendFile(files: string[], backendRoot?: string): boolean {
  return files.some((f) => {
    if (backendRoot && f.startsWith(backendRoot)) return true;
    return BACKEND_FILE_EXTENSIONS.some((ext) => f.endsWith(ext));
  });
}

function allFilesInFrontend(files: string[], frontendRoot?: string): boolean {
  if (files.length === 0) return false;
  if (!frontendRoot) {
    // frontend_root 미지정이면 보수적으로 확장자 기준 판단
    return files.every((f) => /\.(tsx?|jsx?|css|scss|html|vue)$/.test(f));
  }
  return files.every((f) => f.startsWith(frontendRoot));
}

function collectFiles(issue: ParsedIssue): string[] {
  const metaFiles = issue.meta?.files ?? [];
  const bodyFiles = issue.parsedContent.affectedFiles ?? [];
  return [...new Set([...metaFiles, ...bodyFiles])];
}

/**
 * 이슈 소유권을 판정합니다.
 */
export function checkOwnership(
  issue: ParsedIssue,
  project: ResolvedProject,
): OwnershipDecision {
  const scope: ProjectScope = project.config.scope ?? 'full-stack';

  // scope가 full-stack이면 모든 이슈 수락
  if (scope === 'full-stack') {
    return { action: 'accept', reason: 'project scope is full-stack', basis: 'scope-default' };
  }

  // ---- 1. 라벨 (최고 신뢰도) ----
  const hasFrontendLabel = issue.labels.includes(FRONTEND_AGENT_LABEL);
  const hasBackendLabel = issue.labels.some((l) => BACKEND_AGENT_LABELS.includes(l));

  if (scope === 'frontend-only') {
    if (hasFrontendLabel) {
      return { action: 'accept', reason: `${FRONTEND_AGENT_LABEL} label present`, basis: 'label' };
    }
    if (hasBackendLabel) {
      return { action: 'skip', reason: 'backend agent label present', basis: 'label' };
    }
  } else if (scope === 'backend-only') {
    if (hasBackendLabel) {
      return { action: 'accept', reason: 'backend agent label present', basis: 'label' };
    }
    if (hasFrontendLabel) {
      return { action: 'skip', reason: `${FRONTEND_AGENT_LABEL} label present`, basis: 'label' };
    }
  }

  // ---- 2. 파일 경로 휴리스틱 ----
  const files = collectFiles(issue);
  const frontendRoot = project.config.project_structure.frontend_root;
  const backendRoot = project.config.project_structure.backend_root;

  if (files.length > 0) {
    const frontendOnly = allFilesInFrontend(files, frontendRoot);
    const touchesBackend = hasBackendFile(files, backendRoot);

    if (scope === 'frontend-only') {
      if (frontendOnly && !touchesBackend) {
        return { action: 'accept', reason: 'all files under frontend_root', basis: 'path' };
      }
      if (touchesBackend) {
        return { action: 'skip', reason: 'issue touches backend files (.java / backend_root)', basis: 'path' };
      }
    } else if (scope === 'backend-only') {
      if (touchesBackend && !frontendOnly) {
        return { action: 'accept', reason: 'touches backend files', basis: 'path' };
      }
      if (frontendOnly) {
        return { action: 'skip', reason: 'all files under frontend_root', basis: 'path' };
      }
    }
  }

  // ---- 3. 카테고리 ----
  if (scope === 'frontend-only' && issue.category === 'frontend') {
    return { action: 'accept', reason: 'category=frontend', basis: 'category' };
  }

  // ---- 4. 우선순위 fallback ----
  // 판단 불가 상태:
  //   - P0/P1: 실수로 넘기면 운영 영향 큼 → hold-for-review (사람이 라벨 지정)
  //   - P2/P3: 조용히 skip
  if (issue.priority === 'P0' || issue.priority === 'P1') {
    return {
      action: 'hold-for-review',
      reason: `ownership unclear for ${issue.priority}; add ${FRONTEND_AGENT_LABEL} or ${BACKEND_AGENT_LABELS[0]} label`,
      basis: 'priority-fallback',
    };
  }

  return {
    action: 'skip',
    reason: `ownership unclear; scope=${scope} but no label/path/category match`,
    basis: 'priority-fallback',
  };
}
