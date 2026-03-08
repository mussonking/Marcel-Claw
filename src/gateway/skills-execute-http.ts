/**
 * Gateway HTTP handler for POST /skills/execute
 *
 * Executes a skill.yaml-defined skill with the given parameters.
 * Auth: same gateway auth as /tools/invoke.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildDefaultAuthPresets,
  createBridgeLlmHandler,
  discoverExecutableSkills,
  loadSkillDefinition,
  runSkill,
} from "../skills/executor/index.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const log = createSubsystemLogger("skills-execute");
const DEFAULT_BODY_BYTES = 512 * 1024;

type SkillExecuteBody = {
  skill?: unknown;
  params?: unknown;
  state_dir?: unknown;
};

export async function handleSkillExecuteHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    llmHandler?: (
      prompt: string,
      opts?: { timeout_ms?: number; skill_filter?: string[] },
    ) => Promise<string>;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Handle both /skills/execute and GET /skills/list
  if (url.pathname === "/skills/list" && req.method === "GET") {
    return await handleSkillsList(req, res, opts);
  }

  if (url.pathname !== "/skills/execute") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // Auth
  const cfg = loadConfig();
  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  // Parse body
  const bodyUnknown = await readJsonBodyOrError(req, res, DEFAULT_BODY_BYTES);
  if (bodyUnknown === undefined) {
    return true;
  }
  const body = (bodyUnknown ?? {}) as SkillExecuteBody;

  const skillName = typeof body.skill === "string" ? body.skill.trim() : "";
  if (!skillName) {
    sendInvalidRequest(res, "skills.execute requires body.skill");
    return true;
  }

  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  const stateDir =
    typeof body.state_dir === "string" ? body.state_dir.trim() || undefined : undefined;

  // Discover skills
  const workspaceSkillsDir = path.join(
    process.env.HOME ?? "/tmp",
    ".openclaw",
    "workspace",
    "skills",
  );
  const skills = discoverExecutableSkills(workspaceSkillsDir);
  const skillPath = skills.get(skillName);

  if (!skillPath) {
    sendJson(res, 404, {
      ok: false,
      error: { type: "not_found", message: `Executable skill not found: ${skillName}` },
    });
    return true;
  }

  // Load and execute
  try {
    const definition = loadSkillDefinition(skillPath);
    log.info(`Executing skill: ${skillName}`, { params });

    const result = await runSkill(definition, {
      skill: skillName,
      params,
      state_dir: stateDir,
      auth_presets: buildDefaultAuthPresets(),
      llm_handler: opts.llmHandler ?? createBridgeLlmHandler(),
    });

    sendJson(res, result.ok ? 200 : 500, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Skill execution failed: ${skillName}`, { error: message });
    sendJson(res, 500, {
      ok: false,
      error: { type: "execution_error", message },
    });
  }

  return true;
}

async function handleSkillsList(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const cfg = loadConfig();
  const token = getBearerToken(req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  const workspaceSkillsDir = path.join(
    process.env.HOME ?? "/tmp",
    ".openclaw",
    "workspace",
    "skills",
  );
  const skills = discoverExecutableSkills(workspaceSkillsDir);

  const list: { name: string; path: string }[] = [];
  for (const [name, skillPath] of skills) {
    list.push({ name, path: skillPath });
  }

  sendJson(res, 200, { ok: true, skills: list });
  return true;
}
