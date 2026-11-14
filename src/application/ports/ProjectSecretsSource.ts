/**
 * Literal values from the project's environment files (`.env`, `.env.*`),
 * read once at startup so outbound text can be scrubbed of them. Returns the
 * raw values; the domain decides which are worth redacting.
 */
export interface ProjectSecretsSource {
  load(): readonly string[]
}
