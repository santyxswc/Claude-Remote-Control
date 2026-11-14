/**
 * Wires F11: `send_chart` over the decorated chart renderer (the spec's
 * strings redacted first), the private scratch space under the state
 * directory and the decorated image gateway (the caption redacted).
 */
import { FileCaptureScratch } from '../adapters/capture/FileCaptureScratch.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { ChartRenderer } from '../application/ports/ChartRenderer.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { ImageGateway } from '../application/ports/ImageGateway.ts'
import type { Logger } from '../application/ports/Logger.ts'
import { AuthorizeReplyTarget } from '../application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { SendChart } from '../application/use-cases/SendChart.ts'

export interface ChartWiring {
  readonly stateDir: string
  readonly state: Pick<StateStores, 'allowed' | 'audit'>
  /** The decorated outbound from `buildOutbound`, built with a chart renderer. */
  readonly outbound: ImageGateway & ChartRenderer
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
}

export function buildCharts(wiring: ChartWiring): SendChart {
  return new SendChart({
    renderer: wiring.outbound,
    scratch: new FileCaptureScratch(wiring.stateDir, wiring.logger),
    images: wiring.outbound,
    // Images only go to the private chat of an allowlisted sender: never the dev chat.
    target: new AuthorizeReplyTarget(new AuthorizeSender(wiring.state.allowed)),
    caption: (caption) => wiring.messages.chartCaption(caption),
    audit: wiring.state.audit,
    clock: wiring.clock,
    logger: wiring.logger,
  })
}
