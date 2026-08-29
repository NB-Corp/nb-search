const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const KEY_VALUE_PATTERN = /\b(api[_-]?key|token|secret|authorization)\b\s*[:=]\s*[^\s,;]+/gi;

export function redactText(value: string, redactions: readonly string[] = []): string {
  let redacted = value.replace(BEARER_PATTERN, 'Bearer <redacted-secret>');
  redacted = redacted.replace(KEY_VALUE_PATTERN, '$1=<redacted-secret>');
  for (const item of [...redactions].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(item).join(item.includes('://') ? '<redacted-provider-url>' : '<redacted-secret>');
  }
  return redacted;
}

export function safeErrorMessage(error: unknown, redactions: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, redactions);
}
