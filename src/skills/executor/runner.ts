/**
 * Skill Executor — Runner (orchestrator)
 *
 * Executes skill steps sequentially, managing state directory and context.
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { executeHttpStep } from "./steps/http.js";
import { executeLlmStep } from "./steps/llm.js";
import { executeShellStep } from "./steps/shell.js";
import { executeTemplateStep } from "./steps/template-step.js";
import type { TemplateContext } from "./template.js";
import type {
  ExecuteSkillOptions,
  ExecuteSkillResult,
  SkillDefinition,
  SkillRunState,
  SkillStep,
  StepResult,
} from "./types.js";

const log = createSubsystemLogger("skill-executor");

function resolveStateDir(skillName: string, baseDir?: string): string {
  const base =
    baseDir ?? path.join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "skill-runs");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(base, `${skillName}-${timestamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function validateParams(
  definition: SkillDefinition,
  params: Record<string, unknown>,
): string | null {
  for (const [name, def] of Object.entries(definition.params)) {
    const value = params[name];
    if (def.required !== false && value === undefined && def.default === undefined) {
      return `Missing required param: ${name}`;
    }
  }
  return null;
}

function resolveParams(
  definition: SkillDefinition,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(definition.params)) {
    resolved[name] = raw[name] ?? def.default;
  }
  return resolved;
}

async function executeStep(
  step: SkillStep,
  ctx: TemplateContext,
  opts: ExecuteSkillOptions,
): Promise<StepResult> {
  switch (step.type) {
    case "shell":
      return executeShellStep(step, ctx);
    case "http":
      return await executeHttpStep(step, ctx, opts.auth_presets);
    case "llm":
      return await executeLlmStep(step, ctx, opts.llm_handler);
    case "template":
      return executeTemplateStep(step, ctx);
    default:
      return {
        name: (step as { name: string }).name,
        status: "error",
        error: `Unknown step type: ${(step as { type: string }).type}`,
        duration_ms: 0,
      };
  }
}

/**
 * Execute a skill definition with the given parameters.
 */
export async function runSkill(
  definition: SkillDefinition,
  opts: ExecuteSkillOptions,
): Promise<ExecuteSkillResult> {
  // Validate params
  const validationError = validateParams(definition, opts.params);
  if (validationError) {
    return { ok: false, state_dir: "", steps: [], error: validationError };
  }

  const params = resolveParams(definition, opts.params);
  const stateDir = opts.state_dir ?? resolveStateDir(definition.name);

  log.info(`Starting skill: ${definition.name}`, { state_dir: stateDir });

  // Build template context
  const ctx: TemplateContext = {
    params,
    env: process.env as Record<string, string | undefined>,
    state_dir: stateDir,
    steps: {},
  };

  const runState: SkillRunState = {
    skill: definition.name,
    params,
    state_dir: stateDir,
    started_at: new Date().toISOString(),
    steps: [],
    status: "running",
  };

  // Write initial state
  const statePath = path.join(stateDir, "_state.json");
  fs.writeFileSync(statePath, JSON.stringify(runState, null, 2), "utf-8");

  // Execute steps sequentially
  for (const step of definition.steps) {
    log.info(`Step: ${step.name} (${step.type})`, { skill: definition.name });

    const result = await executeStep(step, ctx, opts);
    runState.steps.push(result);

    // Update context with step output
    ctx.steps[step.name] = { output: result.output };

    // Persist state after each step
    fs.writeFileSync(statePath, JSON.stringify(runState, null, 2), "utf-8");

    if (result.status === "error") {
      log.error(`Step failed: ${step.name}`, {
        skill: definition.name,
        error: result.error,
      });
      runState.status = "error";
      runState.error = `Step "${step.name}" failed: ${result.error}`;
      fs.writeFileSync(statePath, JSON.stringify(runState, null, 2), "utf-8");

      return {
        ok: false,
        state_dir: stateDir,
        steps: runState.steps,
        error: runState.error,
      };
    }

    log.info(`Step done: ${step.name} (${result.duration_ms}ms)`, {
      skill: definition.name,
    });
  }

  runState.status = "done";
  fs.writeFileSync(statePath, JSON.stringify(runState, null, 2), "utf-8");

  log.info(`Skill complete: ${definition.name}`, { state_dir: stateDir });

  return {
    ok: true,
    state_dir: stateDir,
    steps: runState.steps,
  };
}
