const REDACTED = "[REDACTED]"

const CREDENTIAL_HEADER = /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi
const CREDENTIAL_JSON = /("([^"\\]*(?:\\.[^"\\]*)*)"\s*:\s*)"((?:\\.|[^"\\])*)"/g
const CREDENTIAL_ASSIGNMENT = /((?:^|[^\w])([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED)
  }
  return result
    .replace(CREDENTIAL_HEADER, `$1${REDACTED}`)
    .replace(CREDENTIAL_JSON, (match, prefix: string, key: string) => {
      const decodedKey = decodeJsonString(key)
      return decodedKey !== undefined && isCredentialKey(decodedKey) ? `${prefix}"${REDACTED}"` : match
    })
    .replace(CREDENTIAL_ASSIGNMENT, (match, prefix: string, key: string) => isCredentialKey(key) ? `${prefix}${REDACTED}` : match)
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactText(message, secrets).slice(0, 2000)
}

function isCredentialKey(value: string): boolean {
  const key = value.replace(/[_-]/g, "").toLowerCase()
  return key === "auth"
    || key.endsWith("authorization")
    || key.endsWith("authcontent")
    || key.endsWith("password")
    || key.endsWith("token")
    || key.endsWith("secret")
    || key.endsWith("credential")
    || key.endsWith("apikey")
    || key.endsWith("privatekey")
}

function decodeJsonString(value: string): string | undefined {
  try {
    const decoded = JSON.parse(`"${value}"`)
    return typeof decoded === "string" ? decoded : undefined
  } catch {
    return undefined
  }
}
