const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /private/i,
  /income/i,
  /credit/i,
  /reservation/i,
  /salary/i,
  /budget/i,
  /secret/i,
  /max[_-]?price/i,
  /min[_-]?price/i,
  /notes?/i
];

const SENSITIVE_STRING_PATTERNS: RegExp[] = [
  /credit\s*score/i,
  /income/i,
  /reservation\s*price/i,
  /max\s*price/i,
  /private\s*context/i,
  /ignore\s+previous\s+instructions/i,
  /reveal\s+private/i
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function isSensitiveStringValue(value: string): boolean {
  return SENSITIVE_STRING_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSensitiveData<T>(value: T, marker = '[REDACTED]'): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, marker)) as T;
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = marker;
      } else {
        result[key] = redactSensitiveData(item, marker);
      }
    }
    return result as T;
  }

  if (typeof value === 'string' && isSensitiveStringValue(value)) {
    return marker as T;
  }

  return value;
}

export function findSensitivePaths(value: unknown, path = 'root'): string[] {
  const paths: string[] = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      paths.push(...findSensitivePaths(item, `${path}[${index}]`));
    });
    return paths;
  }

  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = `${path}.${key}`;
      if (isSensitiveKey(key)) {
        paths.push(nextPath);
      }
      paths.push(...findSensitivePaths(item, nextPath));
    }
    return paths;
  }

  if (typeof value === 'string' && isSensitiveStringValue(value)) {
    paths.push(path);
  }

  return paths;
}

export function assertPrivacySafePublicPayload(value: unknown, context: string): void {
  const sensitivePaths = findSensitivePaths(value);
  if (sensitivePaths.length > 0) {
    throw new Error(`${context}: sensitive_content_detected:${sensitivePaths.join(',')}`);
  }
}

export function redactForLog(value: unknown): unknown {
  return redactSensitiveData(value);
}
