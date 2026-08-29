const REDACTED = "[REDACTED]"

const CREDENTIAL_HEADER = /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi
const CREDENTIAL_JSON = /("(?:password|token|secret|credential|auth(?:orization|_content)?)"\s*:\s*")[^"]*(")/gi

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED)
  }
  return result.replace(CREDENTIAL_HEADER, `$1${REDACTED}`).replace(CREDENTIAL_JSON, `$1${REDACTED}$2`)
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactText(message, secrets).slice(0, 2000)
}

export function redactRecord<T>(value: T, secrets: readonly string[] = []): T {
  return redactValue(value, secrets) as T
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (!value || typeof value !== "object") return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialKey(key)) result[key] = REDACTED
    else result[key] = redactValue(item, secrets)
  }
  return result
}

function isCredentialKey(key: string): boolean {
  return /(?:password|token|secret|credential|auth(?:orization|_content)?)/i.test(key)
}
