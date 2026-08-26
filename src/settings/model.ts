export type Mode = "include" | "exclude";
export type ReadDecision = "inherit" | "auto-read" | "keep-unread";
export type MentionPolicy = "inherit" | "protect" | "allow";
export type ScopeType = "all-dms" | "dm" | "guild" | "category" | "channel";

export interface ScopeRule {
    scopeType: ScopeType;
    scopeId: string;
    decision: ReadDecision;
    mentionPolicy: MentionPolicy;
}

export interface SettingsV1 {
    schemaVersion: 1;
    mode: Mode;
    debounceMs: number;
    reconcileOnStart: boolean;
    globalMentionPolicy: Exclude<MentionPolicy, "inherit">;
    rules: Record<string, ScopeRule>;
}

export type ImportResult = { ok: true; value: SettingsV1 } | { ok: false; error: string };

type JsonRecord = Record<string, unknown>;

const MIN_DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 30_000;

const scopeTypes = new Set<ScopeType>(["all-dms", "dm", "guild", "category", "channel"]);
const readDecisions = new Set<ReadDecision>(["inherit", "auto-read", "keep-unread"]);
const mentionPolicies = new Set<MentionPolicy>(["inherit", "protect", "allow"]);

export const DEFAULT_SETTINGS: Readonly<SettingsV1> = Object.freeze({
    schemaVersion: 1,
    mode: "include",
    debounceMs: 1500,
    reconcileOnStart: false,
    globalMentionPolicy: "protect",
    rules: Object.freeze({}),
});

export function ruleKey(scopeType: ScopeType, scopeId: string): string {
    return `${scopeType}:${scopeId}`;
}

export function normalizeStoredSettings(value: unknown): SettingsV1 {
    const stored = isRecord(value) ? value : {};
    const rules: Record<string, ScopeRule> = {};

    if (isRecord(stored.rules)) {
        for (const [key, candidate] of Object.entries(stored.rules)) {
            const rule = parseRule(candidate);
            if (rule && key === ruleKey(rule.scopeType, rule.scopeId)) {
                rules[key] = rule;
            }
        }
    }

    return {
        schemaVersion: 1,
        mode: isMode(stored.mode) ? stored.mode : DEFAULT_SETTINGS.mode,
        debounceMs: normalizeDebounce(stored.debounceMs),
        reconcileOnStart:
            typeof stored.reconcileOnStart === "boolean"
                ? stored.reconcileOnStart
                : DEFAULT_SETTINGS.reconcileOnStart,
        globalMentionPolicy: isGlobalMentionPolicy(stored.globalMentionPolicy)
            ? stored.globalMentionPolicy
            : DEFAULT_SETTINGS.globalMentionPolicy,
        rules,
    };
}

export function parseImportedSettings(json: string): ImportResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { ok: false, error: "Invalid settings JSON" };
    }

    if (!isRecord(parsed)) {
        return { ok: false, error: "Invalid settings document" };
    }
    if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion !== 1) {
        return { ok: false, error: `Unsupported settings schema: ${parsed.schemaVersion}` };
    }
    if (
        parsed.schemaVersion !== 1 ||
        !isMode(parsed.mode) ||
        !isStrictDebounce(parsed.debounceMs)
    ) {
        return { ok: false, error: "Invalid settings document" };
    }
    if (
        typeof parsed.reconcileOnStart !== "boolean" ||
        !isGlobalMentionPolicy(parsed.globalMentionPolicy)
    ) {
        return { ok: false, error: "Invalid settings document" };
    }
    if (!isRecord(parsed.rules)) {
        return { ok: false, error: "Invalid settings document" };
    }

    const rules: Record<string, ScopeRule> = {};
    for (const [key, candidate] of Object.entries(parsed.rules)) {
        const rule = parseRule(candidate);
        if (!rule || key !== ruleKey(rule.scopeType, rule.scopeId)) {
            return { ok: false, error: "Invalid settings document" };
        }
        rules[key] = rule;
    }

    return {
        ok: true,
        value: {
            schemaVersion: 1,
            mode: parsed.mode,
            debounceMs: parsed.debounceMs,
            reconcileOnStart: parsed.reconcileOnStart,
            globalMentionPolicy: parsed.globalMentionPolicy,
            rules,
        },
    };
}

function normalizeDebounce(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SETTINGS.debounceMs;
    }
    if (value === 0) {
        return 0;
    }
    return Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, value));
}

function parseRule(value: unknown): ScopeRule | undefined {
    if (!isRecord(value) || !isScopeType(value.scopeType) || !isNonEmptyId(value.scopeId)) {
        return undefined;
    }
    if (!isReadDecision(value.decision) || !isMentionPolicy(value.mentionPolicy)) {
        return undefined;
    }
    if (value.scopeType === "all-dms" && value.scopeId !== "all") {
        return undefined;
    }
    return {
        scopeType: value.scopeType,
        scopeId: value.scopeId,
        decision: value.decision,
        mentionPolicy: value.mentionPolicy,
    };
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is Mode {
    return value === "include" || value === "exclude";
}

function isScopeType(value: unknown): value is ScopeType {
    return typeof value === "string" && scopeTypes.has(value as ScopeType);
}

function isReadDecision(value: unknown): value is ReadDecision {
    return typeof value === "string" && readDecisions.has(value as ReadDecision);
}

function isMentionPolicy(value: unknown): value is MentionPolicy {
    return typeof value === "string" && mentionPolicies.has(value as MentionPolicy);
}

function isGlobalMentionPolicy(value: unknown): value is Exclude<MentionPolicy, "inherit"> {
    return value === "protect" || value === "allow";
}

function isNonEmptyId(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isStrictDebounce(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (value === 0 || (value >= MIN_DEBOUNCE_MS && value <= MAX_DEBOUNCE_MS))
    );
}
