import type { ResolvedProject } from './types/index.js';

/**
 * 프로젝트명으로 설정을 해석합니다.
 * configs/projects.json에서 설정을 로드하고, 로컬 경로 및 Git 상태를 확인합니다.
 *
 * @param projectName - configs/projects.json의 키
 * @returns ResolvedProject
 */
export async function resolveProject(
  projectName: string,
): Promise<ResolvedProject> {
  // Phase 2에서 구현
  throw new Error(`Not implemented - Phase 2 (project: ${projectName})`);
}

/**
 * 활성화된 모든 프로젝트를 해석합니다.
 *
 * @returns 활성화된 프로젝트 목록
 */
export async function resolveAllProjects(): Promise<ResolvedProject[]> {
  // Phase 2에서 구현
  throw new Error('Not implemented - Phase 2');
}
