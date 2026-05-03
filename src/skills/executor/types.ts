/**
 * Skill Executor — Type definitions
 *
 * Executable skills that run deterministic steps (shell, http, template)
 * and optionally delegate to the LLM agent for intelligence-requiring steps.
 */

// ── Step types ────────────────────────────────────────────────────────────────

export type ShellStep = {
  name: string;
  type: "shell";
  cmd: string;
  save_to?: string;
  timeout_ms?: number;
};

export type HttpStep = {
  name: string;
  type: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: string; // auth preset name (e.g., "github-app", "telegram")
  save_to?: string;
  timeout_ms?: number;
};

export type LlmStep = {
  name: string;
  type: "llm";
  prompt: string;
  save_to?: string;
  timeout_ms?: number;
  /** Optional skill filter — only these skills are available to the agent during this step */
  skill_filter?: string[];
};

export type TemplateStep = {
  name: string;
  type: "template";
  input: string; // template string to render
  save_to: string;
};

export type SkillStep = ShellStep | HttpStep | LlmStep | TemplateStep;

// ── Param definitions ─────────────────────────────────────────────────────────

export type SkillParamDef = {
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
};

// ── Skill definition (parsed from skill.yaml) ────────────────────────────────

export type SkillDefinition = {
  name: string;
  description: string;
  version: number;
  params: Record<string, SkillParamDef>;
  steps: SkillStep[];
};

// ── Runtime state ─────────────────────────────────────────────────────────────

export type StepResult = {
  name: string;
  status: "ok" | "error";
  output?: string; // file content or response body
  error?: string;
  duration_ms: number;
};

export type SkillRunState = {
  skill: string;
  params: Record<string, unknown>;
  state_dir: string;
  started_at: string;
  steps: StepResult[];
  status: "running" | "done" | "error";
  error?: string;
};

// ── Auth preset ───────────────────────────────────────────────────────────────

export type AuthPreset = {
  type: "bearer" | "header";
  /** For "bearer": the token value. For "header": key-value pairs. */
  resolve: () => Promise<{ headers: Record<string, string> }>;
};

// ── Execute options ───────────────────────────────────────────────────────────

export type ExecuteSkillOptions = {
  skill: string;
  params: Record<string, unknown>;
  /** Override state dir (default: auto-generated in workspace) */
  state_dir?: string;
  /** Auth presets available for http steps */
  auth_presets?: Record<string, AuthPreset>;
  /** Function to send a prompt to the LLM agent and get a response */
  llm_handler?: (
    prompt: string,
    opts?: { timeout_ms?: number; skill_filter?: string[] },
  ) => Promise<string>;
};

export type ExecuteSkillResult = {
  ok: boolean;
  state_dir: string;
  steps: StepResult[];
  error?: string;
};
