/**
 * AskUserQuestionTool - Interactive user questions
 *
 * In SDK mode, returns a permission_request event and waits
 * for the consumer to provide an answer.
 * In non-interactive mode, returns a default or denies.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

// Callback for handling user questions (set by the agent)
let questionHandler: ((question: string, options?: string[]) => Promise<string>) | null = null

/**
 * Set the question handler for AskUserQuestion.
 */
export function setQuestionHandler(
  handler: (question: string, options?: string[]) => Promise<string>,
): void {
  questionHandler = handler
}

/**
 * Clear the question handler.
 */
export function clearQuestionHandler(): void {
  questionHandler = null
}

export const AskUserQuestionTool: ToolDefinition = {
  name: 'AskUserQuestion',
  description: `Ask the user a question and wait for their response. Displays a structured popup with optional choices.

Suitable scenarios:
- User needs to choose from multiple options (e.g., plan selection, file selection)
- Explicit confirmation before high-risk operations
- User instruction is ambiguous and needs clarification
- Interactive Q&A: personality tests, surveys, story interactions where you need per-question feedback

Interactive Q&A mode:
- Call AskUserQuestion once per question — show only the current question
- After the user answers, determine the next question based on their response
- Progress step by step until all questions are completed
- Do NOT list all questions in plain text — use multiple AskUserQuestion calls to unfold them one by one`,
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user. For interactive Q&A, this is the single current question (not all questions at once).' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional choices for the user to select from. Recommended for most scenarios to speed up user response.',
      },
      allow_multiselect: {
        type: 'boolean',
        description: 'Whether to allow multiple selections (for options)',
      },
    },
    required: ['question'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Ask the user a question with optional choices. One question at a time for interactive Q&A.' },
  async call(input: any): Promise<ToolResult> {
    if (questionHandler) {
      try {
        const answer = await questionHandler(input.question, input.options)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: answer,
        }
      } catch (err: any) {
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `User declined to answer: ${err.message}`,
          is_error: true,
        }
      }
    }

    // Non-interactive: return informative message
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `[Non-interactive mode] Question: ${input.question}${input.options ? `\nOptions: ${input.options.join(', ')}` : ''}\n\nNo user available to answer. Proceeding with best judgment.`,
    }
  },
}
