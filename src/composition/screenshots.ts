/**
 * Wires F5: the capture strategies picked for this machine, the private
 * scratch space under the state directory and the decorated image gateway,
 * behind one `CaptureScreenshot` shared by `/shot` and `send_screenshot`
 * (so "one capture at a time" holds across both).
 */

import type { CaptureSetup } from '../adapters/capture/createScreenCapturers.ts'
import { FileCaptureScratch } from '../adapters/capture/FileCaptureScratch.ts'
import type { StateStores } from '../adapters/storage/openState.ts'
import type { Messages } from '../application/i18n/messages.ts'
import type { Clock } from '../application/ports/Clock.ts'
import type { ImageGateway } from '../application/ports/ImageGateway.ts'
import type { Logger } from '../application/ports/Logger.ts'
import { AuthorizeReplyTarget } from '../application/use-cases/AuthorizeReplyTarget.ts'
import { AuthorizeSender } from '../application/use-cases/AuthorizeSender.ts'
import { CaptureScreenshot } from '../application/use-cases/CaptureScreenshot.ts'

export interface ScreenshotWiring {
  readonly stateDir: string
  readonly state: Pick<StateStores, 'allowed' | 'audit'>
  /** From `createScreenCapturers` (or a test double). */
  readonly setup: CaptureSetup
  /** The decorated gateway from `buildOutbound`. */
  readonly images: ImageGateway
  readonly messages: Messages
  readonly clock: Clock
  readonly logger: Logger
}

export function buildScreenshots(wiring: ScreenshotWiring): CaptureScreenshot {
  const { messages } = wiring
  return new CaptureScreenshot({
    capturers: wiring.setup.capturers,
    unavailable: wiring.setup.unavailable,
    scratch: new FileCaptureScratch(wiring.stateDir, wiring.logger),
    images: wiring.images,
    // Images only go to the private chat of an allowlisted sender: never the dev chat.
    target: new AuthorizeReplyTarget(new AuthorizeSender(wiring.state.allowed)),
    caption: (target) =>
      messages.shotCaption(target.kind === 'url' ? { kind: 'url', url: target.url } : target),
    audit: wiring.state.audit,
    clock: wiring.clock,
    logger: wiring.logger,
  })
}
