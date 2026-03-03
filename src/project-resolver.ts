import { readFileSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { ProjectsConfig, ProjectConfig, ResolvedProject } from './types/index.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedConfig: ProjectsConfig | null = null;

/**
 * 문자열 내의 ${VAR} 패턴을 환경변수 값으로 치환합니다.
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * configs/projects.json을 로드합니다 (캐시 활용).
 * local_path 등의 환경변수 참조(${HOME})를 실제 값으로 치환합니다.
 */
function loadProjectsConfig(): ProjectsConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = resolve(__dirname, '..', 'configs', 'projects.json');
  const raw = readFileSync(configPath, 'utf-8');
  const expanded = expandEnvVars(raw);
  cachedConfig = JSON.parse(expanded) as ProjectsConfig;
  return cachedConfig;
}

/**
 * 로컬 경로의 존재 여부를 확인합니다.
 */
function checkLocalPath(localPath: string): boolean {
  return existsSync(localPath);
}

/**
 * Git 저장소의 상태를 확인합니다.
 */
async function getGitStatus(
  localPath: string,
): Promise<ResolvedProject['gitStatus']> {
  try {
    const opts = { cwd: localPath };

    const { stdout: branchOut } = await execAsync(
      'git rev-parse --abbrev-ref HEAD',
      opts,
    );
    const currentBranch = branchOut.trim();

    const { stdout: statusOut } = await execAsync(
      'git status --porcelain',
      opts,
    );
    const isClean = statusOut.trim() === '';

    let behindRemote = 0;
    let aheadRemote = 0;

    try {
      await execAsync('git fetch --quiet', opts);
      const { stdout: revOut } = await execAsync(
        `git rev-list --left-right --count origin/${currentBranch}...HEAD`,
        opts,
      );
      const parts = revOut.trim().split(/\s+/);
      if (parts.length === 2) {
        behindRemote = parseInt(parts[0], 10) || 0;
        aheadRemote = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // 원격 브랜치가 없는 경우 무시
    }

    return { currentBranch, isClean, behindRemote, aheadRemote };
  } catch {
    return undefined;
  }
}

/**
 * 프로젝트명으로 설정을 해석합니다.
 */
export async function resolveProject(
  projectName: string,
): Promise<ResolvedProject> {
  const config = loadProjectsConfig();
  const projectConfig = config.projects[projectName];

  if (!projectConfig) {
    throw new Error(
      `Project "${projectName}" not found in projects.json. Available: ${Object.keys(config.projects).join(', ')}`,
    );
  }

  if (!projectConfig.enabled) {
    throw new Error(`Project "${projectName}" is disabled in projects.json`);
  }

  const localPathExists = checkLocalPath(projectConfig.local_path);
  let gitStatus: ResolvedProject['gitStatus'];

  if (localPathExists) {
    gitStatus = await getGitStatus(projectConfig.local_path);
  }

  return {
    name: projectName,
    config: projectConfig,
    localPathExists,
    gitStatus,
  };
}

/**
 * 활성화된 모든 프로젝트를 해석합니다.
 */
export async function resolveAllProjects(): Promise<ResolvedProject[]> {
  const config = loadProjectsConfig();
  const results: ResolvedProject[] = [];

  for (const [name, projectConfig] of Object.entries(config.projects)) {
    if (!projectConfig.enabled) continue;

    const localPathExists = checkLocalPath(projectConfig.local_path);
    let gitStatus: ResolvedProject['gitStatus'];

    if (localPathExists) {
      gitStatus = await getGitStatus(projectConfig.local_path);
    }

    results.push({ name, config: projectConfig, localPathExists, gitStatus });
  }

  return results;
}

/**
 * 프로젝트 설정 목록을 반환합니다 (Git 상태 확인 없이).
 */
export function listProjects(): Array<{ name: string; config: ProjectConfig; enabled: boolean }> {
  const config = loadProjectsConfig();
  return Object.entries(config.projects).map(([name, cfg]) => ({
    name,
    config: cfg,
    enabled: cfg.enabled,
  }));
}
