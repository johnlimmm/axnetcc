import { readFile } from "node:fs/promises";

export const implementation = {
  updatedAt: "2026-09-08", kind: "manual-inventory",
  features: [
    ["응답 서비스", "구현", "업무 입력, Agent 협업, 통합 보고서, 근거 확인과 사용자 피드백"],
    ["피드백 운영 조회", "구현", "서비스에서는 의견 작성·접수 확인. 독립 콘솔에서 전체 만족도·항목·최근 의견 조회"],
    ["Boundary Router v2", "구현", "8개 전문 Agent 중 주관·필수 검토·지원 기관 선택"],
    ["Edge RAG", "구현", "Agent별 근거 검색, 접근 정책 및 식별자 마스킹"],
    ["비동기 실행", "구현", "SSE·polling, 작업 대기열, 재연결과 실행 취소"],
    ["독립 수집기", "구현", "서비스의 지표 전용 API를 5초 간격으로 수집. 브라우저가 닫혀도 동작"],
    ["시계열 저장", "구현", "콘솔의 별도 SQLite에 실행·수집 상태 기록. 기본 보관 기간 30일"],
    ["성능 분석", "구현", "기간·방식·생성 backend별 P50/P95, TTFT·TPOT, 종료 처리량과 오류율"],
    ["벤치마크", "구현", "파일럿·40문항·반복 평가의 고정 v2 보고서. 실시간 데이터와 분리"],
    ["Agent 상태", "부분 구현", "로컬 Ollama 연결 확인. 원격 Edge는 현재 설정 유효성만 확인"],
    ["장애 이전 미수집 데이터 복구", "제한", "수집 전 서비스가 종료되거나 지표 버퍼가 넘치면 완전한 복구를 보장하지 않음"],
    ["분산 수집·운영자 인증", "미구현", "현재 단일 Core·단일 수집기, 콘솔은 기본 loopback에만 바인딩"],
  ],
};

export async function readBenchmarks() {
  return Promise.all([
    ["pilot", "파일럿 평가", "latest-report-v2.json"],
    ["expanded", "40문항 평가", "expanded-report-v2.json"],
    ["repeat", "반복 벤치마크", "repeat-benchmark-report-v2.json"],
  ].map(async ([id, title, file]) => {
    const report = JSON.parse(await readFile(new URL(`../data/evaluation/${file}`, import.meta.url), "utf8"));
    const valid = report.schemaVersion === "mnc-privacy-evaluation/v2" && report.privacyRiskVersion === "v2";
    const byMode = report.summaries ?? (report.modes && !Array.isArray(report.modes) ? report.modes : undefined) ?? Object.fromEntries((report.summary ?? []).map(row => [row.mode, row]));
    return { id, title, file, status: valid ? report.status : "invalid-version", generatedAt: report.generatedAt ?? null, completedRuns: report.completedRuns ?? report.runs ?? null,
      rows: !valid || report.status === "pending-replay" ? [] : Object.entries(byMode).map(([mode, row]) => ({ mode, n: row.n ?? row.privacyRisk?.sampleSize ?? null, quality: row.objectiveQuality ?? row.quality ?? row.overallMean ?? null, latencyMs: row.averageLatencyMs ?? row.latencyMs ?? null, privacyRisk: row.averagePrivacyRiskScore ?? null, boundaryBytes: row.averageBoundaryBytes ?? row.boundaryBytes ?? null, ttftMs: row.ttftMs ?? null, tpotMs: row.tpotMs ?? null,
        agentF1: row.agentMacroF1 ?? row.agentSelectionF1 ?? null, citationValidity: row.citationValidity ?? null, outputPassRate: row.forbiddenOutputPassRate ?? null,
        privacyS: row.privacyRisk?.sensitiveTransmission?.averageRatio ?? null, privacyA: row.privacyRisk?.agentSelection?.averageRatio ?? null, privacyO: row.privacyRisk?.originalDisclosure?.averageRatio ?? null,
      })) };
  }));
}

export async function readRoutingBenchmark() {
  try {
    const report = JSON.parse(await readFile(new URL('../reports/primary-routing-benchmark/routing-benchmark-results.json', import.meta.url), 'utf8'));
    if (report.benchmark !== 'primary-agent-routing-offline-40' || !Array.isArray(report.summary)) return { status: 'unavailable' };
    return { status: 'ready', generatedAt: report.generatedAt, dataset: report.dataset, timing: report.timing,
      rows: report.summary, caveats: report.caveats };
  } catch { return { status: 'unavailable' }; }
}
