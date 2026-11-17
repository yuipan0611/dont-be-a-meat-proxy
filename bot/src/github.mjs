// github.mjs — GitHub REST API client for Issues (F-02, SR-TASK-01~04).
//
// Reads token from environment variable (GITHUB_TOKEN / GITHUB_PAT) or private file.
// Validates title (non-empty after trim).
// Calls official GitHub REST endpoint POST /repos/{owner}/{repo}/issues.

import { readFile } from 'node:fs/promises';

export class GitHubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.details = details;
  }
}

/** Reads token from GITHUB_TOKEN_FILE if set, else GITHUB_TOKEN / PAT env vars. */
export async function loadGitHubToken({
  tokenFile = process.env.GITHUB_TOKEN_FILE,
  envToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT,
} = {}) {
  if (tokenFile) {
    try {
      const content = await readFile(tokenFile, 'utf8');
      const token = content.trim();
      if (token) return token;
    } catch (e) {
      throw new GitHubError('E-GITHUB', `無法讀取 GitHub token 檔：${e.message}`, { tokenFile, cause: e });
    }
  }
  if (typeof envToken === 'string' && envToken.trim().length > 0) {
    return envToken.trim();
  }
  return null;
}

export function createGitHubClient({
  token,
  tokenFile,
  defaultRepo = 'example-org/dont-be-a-meat-proxy',
  baseUrl = 'https://api.github.com',
  fetch = globalThis.fetch,
} = {}) {
  async function resolveToken() {
    if (typeof token === 'function') return await token();
    if (typeof token === 'string' && token.trim()) return token.trim();
    return await loadGitHubToken({ tokenFile });
  }

  async function createIssue({ repo, title, body = '' }) {
    const trimmedTitle = String(title ?? '').trim();
    if (!trimmedTitle) {
      throw new GitHubError('E-TITLE', '標題必填');
    }

    const targetRepo = (repo ?? '').trim() || defaultRepo;
    if (!targetRepo || !targetRepo.includes('/')) {
      throw new GitHubError('E-GITHUB', `無效的 GitHub repo 格式（需為 owner/repo）：${targetRepo}`);
    }

    const currentToken = await resolveToken();
    if (!currentToken) {
      throw new GitHubError('E-GITHUB', '未設定 GitHub Token（請設定 GITHUB_TOKEN 或 GITHUB_TOKEN_FILE）');
    }

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/repos/${targetRepo}/issues`;
    const payload = {
      title: trimmedTitle,
      ...(body ? { body: String(body) } : {}),
    };

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentToken}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'neighbor-hub-bot',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new GitHubError('E-GITHUB', `GitHub 連線失敗：${e.message}`, { reason: 'network', cause: e });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status !== 201) {
      const msg = data?.message || `HTTP ${res.status}`;
      throw new GitHubError('E-GITHUB', `GitHub 建立 Issue 失敗（${res.status}）：${msg}`, { status: res.status, data });
    }

    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      repo: targetRepo,
    };
  }

  return { createIssue, resolveToken };
}
