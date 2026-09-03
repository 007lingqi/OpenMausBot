import type { AcceptanceCondition, WorkItemSnapshot, WorkItemSnapshotPatch } from "./snapshot.ts";

const MAX_INPUT_CHARACTERS = 2_000;
const MAX_INPUT_LINES = 20;
const MAX_FIELD_CHARACTERS = 500;
const MAX_ACCEPTANCE_CONDITIONS = 10;
const MAX_AMBIGUITIES = 10;

export interface StructuredDefinitionInput {
  goal?: string;
  goalConfirmed?: boolean;
  acceptanceConditions?: AcceptanceCondition[];
  blockingAmbiguities?: string[];
}

export interface DefinitionDefaults {
  repository: string;
  /**
   * Retained for configuration compatibility only. Global checks are not
   * task-level acceptance and must never make a new task definition ready.
   */
  acceptanceConditions?: AcceptanceCondition[];
}

function boundedValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} requires a value`);
  if (normalized.length > MAX_FIELD_CHARACTERS) {
    throw new Error(`${label} exceeds ${MAX_FIELD_CHARACTERS} characters`);
  }
  return normalized;
}

function acceptanceCondition(value: string): AcceptanceCondition {
  const separator = value.search(/[|｜]/u);
  if (separator < 0) {
    const result = boundedValue(value, "验收");
    return { description: result, observation: result };
  }
  return {
    description: boundedValue(value.slice(0, separator), "验收结果"),
    observation: boundedValue(value.slice(separator + 1), "验收证据"),
  };
}

function uniqueAcceptance(conditions: readonly AcceptanceCondition[]): AcceptanceCondition[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    const key = `${condition.description}\u0000${condition.observation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parses only four exact, line-oriented user definition fields. Everything
 * else remains evidence text and cannot alter repositories, identity,
 * permissions, execution policy, or any other control-plane setting.
 */
export function parseStructuredDefinitionInput(text: string): StructuredDefinitionInput {
  const normalized = text.trim();
  if (!normalized) throw new Error("Definition input is empty");
  if (normalized.length > MAX_INPUT_CHARACTERS) {
    throw new Error(`Definition input exceeds ${MAX_INPUT_CHARACTERS} characters`);
  }
  const lines = normalized.split(/\r?\n/u);
  if (lines.length > MAX_INPUT_LINES) throw new Error(`Definition input exceeds ${MAX_INPUT_LINES} lines`);

  let goal: string | undefined;
  let goalConfirmed: boolean | undefined;
  const acceptanceConditions: AcceptanceCondition[] = [];
  const ambiguities: string[] = [];
  let ambiguityCleared = false;

  for (const rawLine of lines) {
    const match = /^(目标|确认目标|验收|疑问)\s*[:：]\s*(.*)$/u.exec(rawLine.trim());
    if (!match) continue;
    const [, label, rawValue] = match;
    const value = boundedValue(rawValue, label);

    if (label === "目标") {
      if (goal !== undefined) throw new Error("目标 field may appear only once");
      goal = value;
      continue;
    }
    if (label === "确认目标") {
      if (goalConfirmed !== undefined) throw new Error("确认目标 field may appear only once");
      if (["是", "确认", "已确认"].includes(value)) {
        goalConfirmed = true;
      } else if (["否", "未确认"].includes(value)) {
        goalConfirmed = false;
      } else {
        if (goal !== undefined && goal !== value) throw new Error("目标 and 确认目标 conflict");
        goal = value;
        goalConfirmed = true;
      }
      continue;
    }
    if (label === "验收") {
      acceptanceConditions.push(acceptanceCondition(value));
      if (acceptanceConditions.length > MAX_ACCEPTANCE_CONDITIONS) {
        throw new Error(`验收 exceeds ${MAX_ACCEPTANCE_CONDITIONS} entries`);
      }
      continue;
    }
    if (value === "无") {
      if (ambiguities.length > 0) throw new Error("疑问：无 cannot be combined with other questions");
      ambiguityCleared = true;
      continue;
    }
    if (ambiguityCleared) throw new Error("疑问：无 cannot be combined with other questions");
    ambiguities.push(value);
    if (ambiguities.length > MAX_AMBIGUITIES) throw new Error(`疑问 exceeds ${MAX_AMBIGUITIES} entries`);
  }

  const result: StructuredDefinitionInput = {};
  if (goal !== undefined) result.goal = goal;
  if (goalConfirmed !== undefined) result.goalConfirmed = goalConfirmed;
  if (acceptanceConditions.length > 0) result.acceptanceConditions = uniqueAcceptance(acceptanceConditions);
  if (ambiguities.length > 0 || ambiguityCleared) result.blockingAmbiguities = ambiguities;
  return result;
}

export function buildDefinitionPatchFromText(
  text: string,
  latest: WorkItemSnapshot | null,
  defaults?: DefinitionDefaults,
): WorkItemSnapshotPatch {
  const fact = text.trim();
  const structured = parseStructuredDefinitionInput(fact);
  const hasStructuredFields = Object.keys(structured).length > 0;
  const selectedGoal = structured.goal ?? latest?.goal ?? null;
  const explicitlyConfirmed = structured.goalConfirmed === true && selectedGoal !== null;
  const acceptanceConditions = structured.acceptanceConditions
    ? uniqueAcceptance([...(latest?.acceptanceConditions ?? []), ...structured.acceptanceConditions])
    : undefined;

  const facts = [...(latest?.facts ?? []).filter((value) => value !== fact), fact];
  if (!latest) {
    const patch: WorkItemSnapshotPatch = {
      goal: structured.goal ?? (hasStructuredFields ? null : fact),
      goalConfirmed: explicitlyConfirmed,
      acceptanceConditions: acceptanceConditions ?? [],
      blockingAmbiguities: structured.blockingAmbiguities ?? [],
      facts,
    };
    if (defaults) patch.repository = defaults.repository;
    return patch;
  }

  const patch: WorkItemSnapshotPatch = { facts };
  if (structured.goal !== undefined) patch.goal = structured.goal;
  if (structured.goalConfirmed !== undefined) patch.goalConfirmed = explicitlyConfirmed;
  if (acceptanceConditions !== undefined) patch.acceptanceConditions = acceptanceConditions;
  if (structured.blockingAmbiguities !== undefined) {
    patch.blockingAmbiguities = structured.blockingAmbiguities;
  }
  return patch;
}
