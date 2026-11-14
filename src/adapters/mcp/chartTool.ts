import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ChartOutcome, ChartRequest } from '../../application/use-cases/SendChart.ts'
import { MAX_CHART_SIDE } from '../../domain/charts/chartImage.ts'
import { MAX_CHART_SPEC_BYTES } from '../../domain/charts/chartSpec.ts'
import { errorResult, textResult } from './toolResults.ts'

export const CHART_TOOL_NAME = 'send_chart'

/** Telegram's photo caption limit; a longer one is an error, not silently cut. */
export const MAX_CHART_CAPTION_LENGTH = 1_024

/** Draws a chart and sends it on Claude's behalf; the `SendChart` use case. */
export type ChartHandler = (request: ChartRequest) => Promise<ChartOutcome>

/** The spec's shape is checked by `checkChartSpec`; here only that it is an object. */
export const ChartArgs = z.object({
  chat_id: z.string().min(1),
  spec: z.record(z.string(), z.unknown()),
  caption: z
    .string()
    .max(MAX_CHART_CAPTION_LENGTH, `caption is longer than ${MAX_CHART_CAPTION_LENGTH} characters`)
    .optional(),
})

export const CHART_TOOL: Tool = {
  name: CHART_TOOL_NAME,
  description:
    'Draw a chart from a Vega-Lite spec with inline data and send it to the user as an image. No URLs, files or images inside the spec; text in it is redacted before drawing.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: {
        type: 'string',
        description: 'The chat_id attribute of the inbound <channel> tag',
      },
      spec: {
        type: 'object',
        description: `A Vega-Lite v5/v6 spec (JSON object, at most ${MAX_CHART_SPEC_BYTES} bytes) whose data is inline: data.values or datasets, at most 5,000 rows. data.url, image marks and href are refused.`,
      },
      caption: {
        type: 'string',
        description: 'Optional: a short plain-text caption under the image',
        maxLength: MAX_CHART_CAPTION_LENGTH,
      },
    },
    required: ['chat_id', 'spec'],
  },
}

export function parseChartArgs(
  raw: unknown,
): { ok: true; request: ChartRequest } | { ok: false; result: CallToolResult } {
  const parsed = ChartArgs.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      result: errorResult(`Invalid send_chart arguments: ${z.prettifyError(parsed.error)}`),
    }
  }
  const { chat_id, spec, caption } = parsed.data
  return {
    ok: true,
    request: { chatId: chat_id, spec, ...(caption === undefined ? {} : { caption }) },
  }
}

const SPEC_PROBLEMS: Record<Extract<ChartOutcome, { status: 'invalid_spec' }>['problem'], string> =
  {
    not_an_object: 'spec must be a JSON object.',
    not_vega_lite: 'spec must be Vega-Lite (not a full Vega spec).',
    too_large: `spec is larger than ${MAX_CHART_SPEC_BYTES} bytes.`,
    too_deep: 'spec is nested too deeply.',
    too_many_nodes: 'spec has too many values and keys.',
    too_many_values: 'data has more than 5,000 rows in total; aggregate it first.',
    string_too_long: 'a string in the spec is longer than 2,000 characters.',
    external_resource: 'url and href are not allowed: put the data inline in data.values.',
    image_mark: 'image marks are not allowed.',
    data_generator: 'sequence and graticule generators are not allowed: put the data inline.',
    forbidden_key: '__proto__, constructor and prototype are not allowed as keys.',
  }

export function toChartResult(outcome: ChartOutcome): CallToolResult {
  switch (outcome.status) {
    case 'sent': {
      const redacted =
        outcome.redactions === 0
          ? ''
          : `; ${outcome.redactions} string(s) in the spec were replaced with [REDACTED] before drawing`
      return textResult(
        `sent as a ${outcome.as} (${outcome.width}x${outcome.height} px, ${outcome.bytes} bytes)${redacted}`,
      )
    }
    case 'refused':
      return errorResult(
        outcome.reason === 'busy'
          ? 'Refused: another chart is being drawn; try again in a few seconds.'
          : 'Refused: chat_id is not the chat of a paired user. Use the chat_id of an inbound <channel> message.',
      )
    case 'invalid_spec':
      return errorResult(`Invalid spec at ${outcome.at || '/'}: ${SPEC_PROBLEMS[outcome.problem]}`)
    case 'not_rendered': {
      const detail = outcome.detail === undefined ? '' : ` (${outcome.detail})`
      switch (outcome.reason) {
        case 'invalid_spec':
          return errorResult(`The spec could not be drawn${detail}.`)
        case 'too_big':
          return errorResult(
            `The chart is too big to draw (at most ${MAX_CHART_SIDE}x${MAX_CHART_SIDE} px)${detail}.`,
          )
        case 'timeout':
          return errorResult('Drawing took too long and was stopped; simplify the chart.')
        case 'failed':
          return errorResult(`Drawing failed${detail}.`)
      }
      break
    }
    case 'too_large':
      return errorResult(`Not sent: the image is ${outcome.bytes} bytes, too large to send.`)
    case 'failed':
      return errorResult(`Chart failed while trying to ${outcome.stage}: ${outcome.error}`)
  }
  return errorResult('Chart failed.')
}
