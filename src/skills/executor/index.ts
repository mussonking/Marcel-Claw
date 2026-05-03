/**
 * Skill Executor — Public API
 *
 * Executable skills system for Marcel-Claw.
 * Skills are defined in skill.yaml files and executed deterministically,
 * with optional LLM steps that send minimal prompts to the agent.
 */

export { loadSkillDefinition, discoverExecutableSkills } from "./loader.js";
export { runSkill } from "./runner.js";
export { buildDefaultAuthPresets } from "./auth.js";
export { createBridgeLlmHandler } from "./llm-bridge.js";
export { renderTemplate, renderDeep } from "./template.js";
export type {
  SkillDefinition,
  SkillStep,
  ShellStep,
  HttpStep,
  LlmStep,
  TemplateStep,
  SkillParamDef,
  SkillRunState,
  StepResult,
  AuthPreset,
  ExecuteSkillOptions,
  ExecuteSkillResult,
} from "./types.js";
