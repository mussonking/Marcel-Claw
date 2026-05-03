/**
 * Skill Executor — LLM step runner
 *
 * Sends a rendered prompt to the LLM agent via the provided handler.
 * The agent receives ONLY this prompt — never the full skill definition.
 */

import fs from "node:fs";
import path from "node:path";
import { renderTemplate, type TemplateContext } from "../template.js";
import type { LlmStep, StepResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export async function executeLlmStep(
  step: LlmStep,
  ctx: TemplateContext,
  llmHandler?: (
    prompt: string,
    opts?: { timeout_ms?: number; skill_filter?: string[] },
  ) => Promise<string>,
): Promise<StepResult> {
  const start = Date.now();

  if (!llmHandler) {
    return {
      name: step.name,
      status: "error",
      error: "No LLM handler provided — cannot execute llm step",
      duration_ms: Date.now() - start,
    };
  }

  const prompt = renderTemplate(step.prompt, ctx);
  const timeout = step.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await llmHandler(prompt, {
      timeout_ms: timeout,
      skill_filter: step.skill_filter,
    });

    if (step.save_to) {
      const savePath = path.resolve(ctx.state_dir, step.save_to);
      fs.writeFileSync(savePath, response, "utf-8");
    }

    return {
      name: step.name,
      status: "ok",
      output: response,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: step.name,
      status: "error",
      error: message,
      duration_ms: Date.now() - start,
    };
  }
}
