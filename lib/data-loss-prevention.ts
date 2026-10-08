export type SanitizationResult = {
  sanitized: string;
  filteredFields: string[];
};

const sensitivePatterns = [
  { label: "주민등록번호", regex: /\b\d{6}-?[1-4]\d{6}\b/g },
  { label: "휴대전화", regex: /\b01[016789]-?\d{3,4}-?\d{4}\b/g },
  { label: "이메일", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { label: "내부 IP", regex: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g },
] as const;

/**
 * Core 입력과 Edge 출력에 동일한 최소 DLP 규칙을 적용한다.
 * 정규식 상태를 호출 사이에 공유하지 않도록 매 패턴의 lastIndex를 초기화한다.
 */
export function sanitizeSensitiveText(text: string): SanitizationResult {
  const filteredFields: string[] = [];
  let sanitized = text;
  for (const pattern of sensitivePatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(sanitized)) {
      filteredFields.push(pattern.label);
      pattern.regex.lastIndex = 0;
      sanitized = sanitized.replace(pattern.regex, `[${pattern.label} 제거]`);
    }
    pattern.regex.lastIndex = 0;
  }
  return { sanitized, filteredFields };
}
