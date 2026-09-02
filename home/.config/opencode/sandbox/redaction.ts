const REDACTED = "[REDACTED]"

const CREDENTIAL_HEADER = /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi
const CREDENTIAL_JSON = /("(?:password|token|secret|credential|auth(?:orization|_content)?|api[_-]?key|private[_-]?key)"\s*:\s*")[^"]*(")/gi
const CREDENTIAL_ASSIGNMENT = /((?:password|token|secret|credential|auth(?:orization|_content)?|api[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s,;]+/gi

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED)
  }
  return result
    .replace(CREDENTIAL_HEADER, `$1${REDACTED}`)
    .replace(CREDENTIAL_JSON, `$1${REDACTED}$2`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactText(message, secrets).slice(0, 2000)
}
