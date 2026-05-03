/**
 * Skill Executor — Auth presets
 *
 * Resolves authentication for HTTP steps.
 * Presets are resolved from environment variables or external scripts.
 */

import { execSync } from "node:child_process";
import type { AuthPreset } from "./types.js";

/**
 * GitHub App auth — generates a short-lived installation token via JWT.
 * Requires: GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY_PATH
 */
function createGitHubAppPreset(): AuthPreset {
  return {
    type: "bearer",
    resolve: async () => {
      const scriptPath =
        process.env.GITHUB_TOKEN_SCRIPT ??
        `${process.env.HOME}/.openclaw/workspace/skills/pr-review/get_token.py`;

      const token = execSync(`python3 ${scriptPath}`, {
        encoding: "utf-8",
        timeout: 15_000,
        env: { ...process.env },
      }).trim();

      return {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      };
    },
  };
}

/**
 * Telegram Bot API auth — uses bot token from env.
 */
function createTelegramPreset(): AuthPreset {
  return {
    type: "header",
    resolve: async () => ({
      headers: {}, // Telegram auth is in the URL, not headers
    }),
  };
}

/**
 * Bearer token from environment variable.
 */
function createBearerEnvPreset(envVar: string): AuthPreset {
  return {
    type: "bearer",
    resolve: async () => ({
      headers: {
        Authorization: `Bearer ${process.env[envVar] ?? ""}`,
      },
    }),
  };
}

/**
 * Build default auth presets from environment.
 */
export function buildDefaultAuthPresets(): Record<string, AuthPreset> {
  return {
    "github-app": createGitHubAppPreset(),
    telegram: createTelegramPreset(),
    "bearer-exa": createBearerEnvPreset("EXA_API_KEY"),
    "bearer-tavily": createBearerEnvPreset("TAVILY_API_KEY"),
  };
}
