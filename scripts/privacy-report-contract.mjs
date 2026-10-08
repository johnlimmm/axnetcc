export const PRIVACY_RISK_VERSION = "v2";
export const PRIVACY_REPORT_SCHEMA_VERSION = "mnc-privacy-evaluation/v2";

export class PrivacyReportSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacyReportSchemaError";
  }
}

const numericFields = [
  "score",
  "sensitiveDetectedCount",
  "sensitiveTransmittedCount",
  "sensitiveTransmissionRatio",
  "selectedAgentCount",
  "totalAgentCount",
  "agentSelectionRatio",
  "originalBytes",
  "transmittedOriginalBytes",
  "originalDisclosureRatio",
  "egressEnvelopeCount",
  "recipientCount",
];

const ratioFields = [
  "sensitiveTransmissionRatio",
  "agentSelectionRatio",
  "originalDisclosureRatio",
];

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function normalizePrivacyBreakdownV2(metrics, context = "result.metrics") {
  if (metrics?.privacyRiskVersion !== PRIVACY_RISK_VERSION) {
    throw new PrivacyReportSchemaError(
      `${context}.privacyRiskVersion must be "${PRIVACY_RISK_VERSION}"; ` +
      `received ${JSON.stringify(metrics?.privacyRiskVersion ?? "missing")}.`,
    );
  }
  const risk = metrics.privacyRisk;
  if (!risk || typeof risk !== "object" || risk.privacyRiskVersion !== PRIVACY_RISK_VERSION) {
    throw new PrivacyReportSchemaError(
      `${context}.privacyRisk must contain a ${PRIVACY_RISK_VERSION} breakdown.`,
    );
  }
  for (const field of numericFields) {
    if (!Number.isFinite(risk[field])) {
      throw new PrivacyReportSchemaError(`${context}.privacyRisk.${field} must be finite.`);
    }
  }
  for (const field of ratioFields) {
    if (risk[field] < 0 || risk[field] > 1) {
      throw new PrivacyReportSchemaError(`${context}.privacyRisk.${field} must be in [0, 1].`);
    }
  }
  if (risk.score < 0 || risk.score > 100) {
    throw new PrivacyReportSchemaError(`${context}.privacyRisk.score must be in [0, 100].`);
  }
  if (metrics.privacyRiskScore !== risk.score) {
    throw new PrivacyReportSchemaError(
      `${context}.privacyRiskScore must equal ${context}.privacyRisk.score.`,
    );
  }
  if (typeof risk.privacyPass !== "boolean" || typeof risk.outputLeak !== "boolean") {
    throw new PrivacyReportSchemaError(`${context}.privacyRisk privacyPass/outputLeak must be boolean.`);
  }
  return {
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    score: risk.score,
    sensitiveDetectedCount: risk.sensitiveDetectedCount,
    sensitiveTransmittedCount: risk.sensitiveTransmittedCount,
    sensitiveTransmissionRatio: risk.sensitiveTransmissionRatio,
    selectedAgentCount: risk.selectedAgentCount,
    totalAgentCount: risk.totalAgentCount,
    agentSelectionRatio: risk.agentSelectionRatio,
    originalBytes: risk.originalBytes,
    transmittedOriginalBytes: risk.transmittedOriginalBytes,
    originalDisclosureRatio: risk.originalDisclosureRatio,
    rawDataLeavesEdge: risk.rawDataLeavesEdge === true,
    egressEnvelopeCount: risk.egressEnvelopeCount,
    recipientCount: risk.recipientCount,
    privacyPass: risk.privacyPass,
    outputLeak: risk.outputLeak,
    diagnostics: Array.isArray(risk.diagnostics) ? [...risk.diagnostics] : [],
  };
}

export function privacyExposureState(breakdown) {
  if (breakdown.sensitiveDetectedCount === 0) return "sensitive-not-detected";
  if (breakdown.sensitiveTransmittedCount === 0) return "detected-fully-masked";
  return "sensitive-exposure";
}

export function assertPrivacyRowsV2(rows, context = "report rows") {
  if (!Array.isArray(rows)) {
    throw new PrivacyReportSchemaError(`${context} must be an array.`);
  }
  const versions = new Set(rows.map((row) => row?.privacyRiskVersion ?? "missing"));
  if (versions.size !== 1 || !versions.has(PRIVACY_RISK_VERSION)) {
    throw new PrivacyReportSchemaError(
      `Cannot aggregate mixed privacy report versions in ${context}: ` +
      `${[...versions].sort().join(", ") || "empty"}. Expected only ${PRIVACY_RISK_VERSION}.`,
    );
  }
  for (const [index, row] of rows.entries()) {
    if (!row.privacyRisk || row.privacyRisk.privacyRiskVersion !== PRIVACY_RISK_VERSION) {
      throw new PrivacyReportSchemaError(`${context}[${index}] is missing its v2 privacy breakdown.`);
    }
  }
  return rows;
}

export function summarizePrivacyRowsV2(rows, context = "report rows") {
  assertPrivacyRowsV2(rows, context);
  const risks = rows.map((row) => row.privacyRisk);
  const states = risks.map(privacyExposureState);
  const count = (state) => states.filter((item) => item === state).length;
  return {
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    status: "measured",
    sampleSize: risks.length,
    averageScore: round(mean(risks.map((risk) => risk.score)), 1),
    sensitiveTransmission: {
      weight: 0.5,
      averageNumerator: round(mean(risks.map((risk) => risk.sensitiveTransmittedCount))),
      averageDenominator: round(mean(risks.map((risk) => risk.sensitiveDetectedCount))),
      averageRatio: round(mean(risks.map((risk) => risk.sensitiveTransmissionRatio))),
    },
    agentSelection: {
      weight: 0.3,
      averageNumerator: round(mean(risks.map((risk) => risk.selectedAgentCount))),
      averageDenominator: round(mean(risks.map((risk) => risk.totalAgentCount))),
      averageRatio: round(mean(risks.map((risk) => risk.agentSelectionRatio))),
    },
    originalDisclosure: {
      weight: 0.2,
      averageNumeratorBytes: round(mean(risks.map((risk) => risk.transmittedOriginalBytes))),
      averageDenominatorBytes: round(mean(risks.map((risk) => risk.originalBytes))),
      averageRatio: round(mean(risks.map((risk) => risk.originalDisclosureRatio))),
    },
    exposureStates: {
      sensitiveNotDetected: count("sensitive-not-detected"),
      detectedFullyMasked: count("detected-fully-masked"),
      sensitiveExposure: count("sensitive-exposure"),
    },
    privacyPassRate: round(mean(risks.map((risk) => risk.privacyPass ? 1 : 0)) * 100, 1),
    outputLeakRate: round(mean(risks.map((risk) => risk.outputLeak ? 1 : 0)) * 100, 1),
  };
}

export function assertCompatiblePrivacyReports(reports, context = "reports") {
  const versions = new Set(reports.map((report) => report?.privacyRiskVersion ?? "missing"));
  if (versions.size !== 1 || !versions.has(PRIVACY_RISK_VERSION)) {
    throw new PrivacyReportSchemaError(
      `Cannot combine v1 and v2 privacy reports in ${context}: ` +
      `${[...versions].sort().join(", ") || "empty"}.`,
    );
  }
  return reports;
}
