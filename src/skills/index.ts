/**
 * Skills Module - Public API
 */

// Types
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillResult,
} from './types.js'

// Registry
export {
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  hasSkill,
  unregisterSkill,
  clearSkills,
  formatSkillsForPrompt,
  formatSkillsForSystemPrompt,
  formatSkillsForToolDescription,
} from './registry.js'

// Filesystem loading
export { loadSkillsFromFilesystem } from './filesystem.js'
