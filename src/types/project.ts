/** 기술 스택 정보 */
export interface TechStack {
  backend: 'java-spring-boot' | 'python-fastapi' | 'nodejs-express' | 'none';
  frontend: 'react-typescript' | 'react-vite-mui' | 'vue-typescript' | 'none';
  database: 'postgresql' | 'mariadb' | 'mongodb' | 'sqlite' | 'none';
  build_tool: 'gradle' | 'maven' | 'npm' | 'vite' | 'pip';
  /** 언어 상세 (선택) — "javascript-ts-partial" 등 */
  language?: string;
}

/** Docker Compose 파일 경로 */
export interface DockerComposeConfig {
  local: string;
  production: string;
}

/** 빌드/테스트 명령어 */
export interface ProjectCommands {
  build_backend?: string;
  build_backend_cwd?: string;
  build_frontend?: string;
  build_frontend_cwd?: string;
  test_backend?: string;
  test_backend_cwd?: string;
  test_frontend?: string;
  test_frontend_cwd?: string;
  lint_frontend?: string;
  lint_frontend_cwd?: string;
  lint_backend?: string;
  lint_backend_cwd?: string;
}

/** 서비스 포트 */
export interface Ports {
  frontend?: number;
  backend?: number;
}

/** 서비스 URL */
export interface Urls {
  frontend?: string;
  backend?: string;
  swagger?: string;
}

/** 프로젝트 디렉토리 구조 */
export interface ProjectStructure {
  backend_root?: string;
  frontend_root?: string;
  source_main?: string;
  source_test?: string;
  frontend_src?: string;
}

/**
 * 프로젝트 수정 범위.
 * - full-stack: 백엔드/프론트엔드 모두 (기본값)
 * - frontend-only: 프론트엔드 코드만 수정 — Java 등 백엔드 이슈는 다른 에이전트에 양보
 * - backend-only: 백엔드 코드만 수정 (미래 확장용)
 */
export type ProjectScope = 'full-stack' | 'frontend-only' | 'backend-only';

/** 단일 프로젝트 설정 */
export interface ProjectConfig {
  repo: string;
  local_path: string;
  tech_stack: TechStack;
  main_branch: string;
  deploy_branch?: string;
  docker_compose?: DockerComposeConfig;
  commands: ProjectCommands;
  ports?: Ports;
  urls?: Urls;
  project_structure: ProjectStructure;
  qa_agent_project: string;
  enabled: boolean;
  notes?: string;
  /**
   * 수정 범위 — 생략 시 'full-stack'.
   * 'frontend-only'로 지정 시 이 에이전트는 프론트엔드 이슈만 수락합니다
   * (ownership 필터 동작: src/ownership-filter.ts 참조).
   */
  scope?: ProjectScope;
  /** Docker 서비스 모니터링/배포 설정 (Phase 7+) */
  docker?: import('./docker.js').DockerConfig;
}

/** 전체 프로젝트 설정 파일 */
export interface ProjectsConfig {
  version: string;
  projects: Record<string, ProjectConfig>;
}

/** 프로젝트 resolve 결과 */
export interface ResolvedProject {
  name: string;
  config: ProjectConfig;
  localPathExists: boolean;
  gitStatus?: {
    currentBranch: string;
    isClean: boolean;
    behindRemote: number;
    aheadRemote: number;
  };
}
