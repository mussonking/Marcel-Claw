/**
 * Skill Executor — Shell step runner
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderTemplate, type TemplateContext } from "../template.js";
import type { ShellStep, StepResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export function executeShellStep(step: ShellStep, ctx: TemplateContext): StepResult {
  const start = Date.now();
  const cmd = renderTemplate(step.cmd, ctx);
  const timeout = step.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  try {
    const stdout = execSync(cmd, {
      cwd: ctx.state_dir,
      timeout,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    const output = stdout.trim();

    if (step.save_to) {
      const savePath = path.resolve(ctx.state_dir, step.save_to);
      fs.writeFileSync(savePath, output, "utf-8");
    }

    return {
      name: step.name,
      status: "ok",
      output,
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
