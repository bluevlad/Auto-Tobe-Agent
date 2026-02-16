/** 기술 스택 정보 */
export interface TechStack {
  backend: 'java-spring-boot' | 'python-fastapi' | 'nodejs-express';
  frontend: 'react-typescript' | 'vue-typescript' | 'none';
  database: 'postgresql' | 'mariadb' | 'mongodb' | 'sqlite';
  build_tool: 'gradle' | 'maven' | 'npm' | 'pip';
}

/** Docker Compose 파일 경로 */
export interface DockerComposeConfig {
  local: string;
  production: string;
}

/** 빌드/테스트 명령어 */
export interface ProjectCommands {
  build_backend: string;
  build_frontend?: string;
  test_backend: string;
  test_frontend?: string;
  lint_frontend?: string;
  lint_backend?: string;
}

/** 서비스 포트 */
export interface Ports {
  frontend: number;
  backend: number;
}

/** 서비스 URL */
export interface Urls {
  frontend: string;
  backend: string;
  swagger?: string;
}

/** 프로젝트 디렉토리 구조 */
export interface ProjectStructure {
  backend_root: string;
  frontend_root?: string;
  source_main: string;
  source_test: string;
  frontend_src?: string;
}

/** 단일 프로젝트 설정 */
export interface ProjectConfig {
  repo: string;
  local_path: string;
  tech_stack: TechStack;
  main_branch: string;
  deploy_branch: string;
  docker_compose: DockerComposeConfig;
  commands: ProjectCommands;
  ports: Ports;
  urls: Urls;
  project_structure: ProjectStructure;
  qa_agent_project: string;
  enabled: boolean;
  notes?: string;
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
