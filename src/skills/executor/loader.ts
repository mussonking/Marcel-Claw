/**
 * Skill Executor — Loader
 *
 * Parses skill.yaml files into validated SkillDefinition objects.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { SkillDefinition } from "./types.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ParamDefSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const ShellStepSchema = z.object({
  name: z.string(),
  type: z.literal("shell"),
  cmd: z.string(),
  save_to: z.string().optional(),
  timeout_ms: z.number().optional(),
});

const HttpStepSchema = z.object({
  name: z.string(),
  type: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  auth: z.string().optional(),
  save_to: z.string().optional(),
  timeout_ms: z.number().optional(),
});

const LlmStepSchema = z.object({
  name: z.string(),
  type: z.literal("llm"),
  prompt: z.string(),
  save_to: z.string().optional(),
  timeout_ms: z.number().optional(),
  skill_filter: z.array(z.string()).optional(),
});

const TemplateStepSchema = z.object({
  name: z.string(),
  type: z.literal("template"),
  input: z.string(),
  save_to: z.string(),
});

const StepSchema = z.discriminatedUnion("type", [
  ShellStepSchema,
  HttpStepSchema,
  LlmStepSchema,
  TemplateStepSchema,
]);

const SkillDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.number().default(1),
  params: z.record(z.string(), ParamDefSchema).default({}),
  steps: z.array(StepSchema).min(1),
});

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load and validate a skill.yaml file.
 */
export function loadSkillDefinition(filePath: string): SkillDefinition {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw);
  return SkillDefinitionSchema.parse(parsed) as SkillDefinition;
}

/**
 * Discover all executable skills from a directory.
 * Looks for `skill.yaml` in each subdirectory.
 */
export function discoverExecutableSkills(skillsDir: string): Map<string, string> {
  const skills = new Map<string, string>();
  if (!fs.existsSync(skillsDir)) return skills;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;

    const yamlPath = path.join(skillsDir, entry.name, "skill.yaml");
    if (fs.existsSync(yamlPath)) {
      try {
        const def = loadSkillDefinition(yamlPath);
        skills.set(def.name, yamlPath);
      } catch {
        // skip invalid skill files
      }
    }
  }
  return skills;
}
