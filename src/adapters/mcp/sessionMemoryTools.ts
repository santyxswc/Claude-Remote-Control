import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
  ProposeMemoryOutcome,
  ProposeMemoryRequest,
} from '../../application/use-cases/ProposeMemory.ts'
import type {
  SaveSummaryOutcome,
  SaveSummaryRequest,
} from '../../application/use-cases/SaveSessionSummary.ts'
import { MAX_MEMORY_LINE_LENGTH, MAX_MEMORY_LINES } from '../../domain/memory/MemoryProposal.ts'
import {
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_TITLE_LENGTH,
} from '../../domain/sessions/sessionSummary.ts'
import { errorResult, textResult } from './toolResults.ts'

export const SAVE_SUMMARY_TOOL_NAME = 'save_session_summary'
export const PROPOSE_MEMORY_TOOL_NAME = 'propose_memory'

export type SaveSummaryHandler = (request: SaveSummaryRequest) => Promise<SaveSummaryOutcome>
export type ProposeMemoryHandler = (request: ProposeMemoryRequest) => Promise<ProposeMemoryOutcome>

const CHAT_NOT_ALLOWED =
  'Refused: chat_id is not the chat of a paired user. Use the chat_id of an inbound <channel> message.'

/**
 * Loose bounds only, so a bad request gets a precise answer from the use
 * case; the markdown bound is in UTF-16 units, the byte cap is checked there.
 */
const SaveSummaryArgs = z.object({
  chat_id: z.string().min(1),
  title: z.string().max(4 * MAX_SUMMARY_TITLE_LENGTH),
  markdown: z
    .string()
    .max(MAX_SUMMARY_BYTES, `markdown is longer than ${MAX_SUMMARY_BYTES} characters`),
})

const ProposeMemoryArgs = z.object({
  chat_id: z.string().min(1),
  lines: z.array(z.string().max(4 * MAX_MEMORY_LINE_LENGTH)).max(4 * MAX_MEMORY_LINES),
})

export const SAVE_SUMMARY_TOOL: Tool = {
  name: SAVE_SUMMARY_TOOL_NAME,
  description:
    'Save a Markdown summary of this session to docs/sessions/ in the project (the bridge writes the file; it never overwrites) and send it to the user. Returns the file path.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The chat_id attribute of the inbound <channel> tag',
      },
      title: {
        type: 'string',
        description: `A short title (at most ${MAX_SUMMARY_TITLE_LENGTH} characters); it also names the file`,
        maxLength: MAX_SUMMARY_TITLE_LENGTH,
      },
      markdown: {
        type: 'string',
        description: `The summary as Markdown (at most ${MAX_SUMMARY_BYTES} bytes)`,
      },
    },
    required: ['chat_id', 'title', 'markdown'],
  },
}

export const PROPOSE_MEMORY_TOOL: Tool = {
  name: PROPOSE_MEMORY_TOOL_NAME,
  description:
    'Propose lines to add to the project CLAUDE.md under "## Session notes". The user approves or rejects them with buttons; only then does the bridge write them. Returns at once; the outcome arrives later as a channel message with kind="memory".',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The chat_id attribute of the inbound <channel> tag',
      },
      lines: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_MEMORY_LINE_LENGTH },
        minItems: 1,
        maxItems: MAX_MEMORY_LINES,
        description: `1 to ${MAX_MEMORY_LINES} single-line notes (at most ${MAX_MEMORY_LINE_LENGTH} characters each, no secrets), each becomes a "- " bullet`,
      },
    },
    required: ['chat_id', 'lines'],
  },
}

export function parseSaveSummaryArgs(
  raw: unknown,
): { ok: true; request: SaveSummaryRequest } | { ok: false; result: CallToolResult } {
  const parsed = SaveSummaryArgs.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      result: errorResult(
        `Invalid ${SAVE_SUMMARY_TOOL_NAME} arguments: ${z.prettifyError(parsed.error)}`,
      ),
    }
  }
  const { chat_id, title, markdown } = parsed.data
  return { ok: true, request: { chatId: chat_id, title, markdown } }
}

export function parseProposeMemoryArgs(
  raw: unknown,
): { ok: true; request: ProposeMemoryRequest } | { ok: false; result: CallToolResult } {
  const parsed = ProposeMemoryArgs.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      result: errorResult(
        `Invalid ${PROPOSE_MEMORY_TOOL_NAME} arguments: ${z.prettifyError(parsed.error)}`,
      ),
    }
  }
  return { ok: true, request: { chatId: parsed.data.chat_id, lines: parsed.data.lines } }
}

const SUMMARY_PROBLEMS = {
  empty_title: 'title has no visible text.',
  title_too_long: `title must be at most ${MAX_SUMMARY_TITLE_LENGTH} characters.`,
  empty_summary: 'markdown has no visible text.',
  too_large: `the summary is larger than ${MAX_SUMMARY_BYTES} bytes; shorten it.`,
} as const

const FILE_PROBLEMS = {
  outside_project: 'docs/sessions leads outside the project (a link); the user must fix it.',
  not_a_regular_file: 'docs/sessions is not a directory.',
  too_large: 'the file is too large.',
  changed_meanwhile: 'the file changed while it was being written.',
  no_free_name: 'too many summaries with this name already exist this second.',
  io: 'the file could not be written.',
} as const

export function toSaveSummaryResult(outcome: SaveSummaryOutcome): CallToolResult {
  switch (outcome.status) {
    case 'saved':
      return textResult(
        `saved to ${outcome.path}${outcome.notified ? ' and sent to the user' : '; the chat notice could not be sent'}`,
      )
    case 'refused':
      return errorResult(CHAT_NOT_ALLOWED)
    case 'invalid':
      return errorResult(`Invalid summary: ${SUMMARY_PROBLEMS[outcome.problem]}`)
    case 'not_saved':
      return errorResult(`Not saved: ${FILE_PROBLEMS[outcome.problem]}`)
  }
}

const LINE_PROBLEMS = {
  no_lines: 'give at least one line.',
  too_many_lines: `give at most ${MAX_MEMORY_LINES} lines.`,
  empty_line: 'a line has no visible text.',
  line_too_long: `a line is longer than ${MAX_MEMORY_LINE_LENGTH} characters.`,
  control_characters: 'a line has a line break, tab or control character; one line each.',
  invisible_characters: 'a line has invisible or bidirectional characters.',
  code_fence: 'a line contains a code fence (``` or ~~~).',
  html_comment: 'a line contains an HTML comment marker (<!-- or -->).',
  contains_secret:
    'a line looks like it contains a secret; the user must see exactly what is written.',
  too_long_for_one_message:
    'the lines do not fit in one Telegram message; propose fewer or shorter lines.',
} as const

export function toProposeMemoryResult(outcome: ProposeMemoryOutcome): CallToolResult {
  switch (outcome.status) {
    case 'proposed':
      return textResult(
        `proposed; proposal_id=${outcome.proposalId}. Do not wait and do not edit CLAUDE.md yourself: the outcome arrives later as a channel message with kind="memory" and this proposal_id.`,
      )
    case 'refused':
      return errorResult(
        outcome.reason === 'not_polling'
          ? 'Refused: this session does not receive Telegram updates right now (another session polls the bot, or the hub is not running in hub mode), so nobody could approve.'
          : CHAT_NOT_ALLOWED,
      )
    case 'invalid': {
      const where = outcome.line === undefined ? '' : ` (line ${outcome.line})`
      return errorResult(`Invalid lines${where}: ${LINE_PROBLEMS[outcome.problem]}`)
    }
    case 'failed':
      return errorResult(`Proposing failed: ${outcome.error}`)
  }
}
