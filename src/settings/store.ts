import {
    normalizeStoredSettings,
    parseImportedSettings,
    ruleKey,
    type ImportResult,
    type ScopeRule,
    type ScopeType,
    type SettingsV1,
} from "./model";

const SETTINGS_KEY = "settings";

export class SettingsStore {
    private current: Readonly<SettingsV1> = freezeSettings(normalizeStoredSettings(undefined));
    private readonly listeners = new Set<() => void>();

    constructor(private readonly data: BetterDiscord.BdApi["Data"]) {}

    get snapshot(): Readonly<SettingsV1> {
        return this.current;
    }

    load(): Readonly<SettingsV1> {
        const next = freezeSettings(normalizeStoredSettings(this.data.load<unknown>(SETTINGS_KEY)));
        const changed = !settingsEqual(this.current, next);
        this.current = next;
        if (changed) {
            this.notify();
        }
        return this.current;
    }

    replace(next: SettingsV1): void {
        this.commit(normalizeStoredSettings(next));
    }

    patch(patch: Partial<Omit<SettingsV1, "schemaVersion" | "rules">>): void {
        this.commit(
            normalizeStoredSettings({
                ...this.current,
                ...patch,
                rules: this.current.rules,
            }),
        );
    }

    setRule(rule: ScopeRule): void {
        this.commit(
            normalizeStoredSettings({
                ...this.current,
                rules: {
                    ...this.current.rules,
                    [ruleKey(rule.scopeType, rule.scopeId)]: rule,
                },
            }),
        );
    }

    removeRule(scopeType: ScopeType, scopeId: string): void {
        const key = ruleKey(scopeType, scopeId);
        if (!(key in this.current.rules)) {
            return;
        }
        const rules = { ...this.current.rules };
        delete rules[key];
        this.commit({ ...this.current, rules });
    }

    importJson(json: string): ImportResult {
        const result = parseImportedSettings(json);
        if (result.ok) {
            this.commit(result.value);
        }
        return result;
    }

    exportJson(): string {
        const rules: Record<string, ScopeRule> = {};
        for (const key of Object.keys(this.current.rules).sort()) {
            const rule = this.current.rules[key];
            if (rule) {
                rules[key] = rule;
            }
        }
        return `${JSON.stringify({ ...this.current, rules }, null, 2)}\n`;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private commit(next: SettingsV1): void {
        this.current = freezeSettings(next);
        this.data.save(SETTINGS_KEY, this.current);
        this.notify();
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

function settingsEqual(left: Readonly<SettingsV1>, right: Readonly<SettingsV1>): boolean {
    if (
        left.schemaVersion !== right.schemaVersion ||
        left.mode !== right.mode ||
        left.debounceMs !== right.debounceMs ||
        left.reconcileOnStart !== right.reconcileOnStart ||
        left.globalMentionPolicy !== right.globalMentionPolicy
    ) {
        return false;
    }
    const leftKeys = Object.keys(left.rules).sort();
    const rightKeys = Object.keys(right.rules).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every((key, index) => {
        if (key !== rightKeys[index]) {
            return false;
        }
        const leftRule = left.rules[key];
        const rightRule = right.rules[key];
        return (
            leftRule !== undefined &&
            rightRule !== undefined &&
            leftRule.scopeType === rightRule.scopeType &&
            leftRule.scopeId === rightRule.scopeId &&
            leftRule.decision === rightRule.decision &&
            leftRule.mentionPolicy === rightRule.mentionPolicy
        );
    });
}

function freezeSettings(settings: SettingsV1): Readonly<SettingsV1> {
    const rules: Record<string, ScopeRule> = {};
    for (const [key, rule] of Object.entries(settings.rules)) {
        rules[key] = Object.freeze({ ...rule });
    }
    return Object.freeze({ ...settings, rules: Object.freeze(rules) });
}
