/** Turns a pairing code into a link that opens the bot and sends the code. */
export interface PairingLinkBuilder {
  linkFor(code: string): string
}
