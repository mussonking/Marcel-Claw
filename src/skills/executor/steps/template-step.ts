/**
 * Skill Executor — Template step runner
 *
 * Renders a template string and saves the result to a file.
 */

import fs from "node:fs";
import path from "node:path";
import { renderTemplate, type TemplateContext } from "../template.js";
import type { TemplateStep, StepResult } from "../types.js";

export function executeTemplateStep(step: TemplateStep, ctx: TemplateContext): StepResult {
  const start = Date.now();

  try {
    const rendered = renderTemplate(step.input, ctx);
    const savePath = path.resolve(ctx.state_dir, step.save_to);
    fs.writeFileSync(savePath, rendered, "utf-8");

    return {
      name: step.name,
      status: "ok",
      output: rendered,
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
