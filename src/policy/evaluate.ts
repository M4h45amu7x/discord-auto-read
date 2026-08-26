import {
    ruleKey,
    type MentionPolicy,
    type ReadDecision,
    type ScopeRule,
    type SettingsV1,
} from "../settings/model";
import type { ChannelContext, MentionState, PolicyOutcome, ScopeRef } from "./model";
export type { ChannelContext, MentionState, PolicyOutcome, ScopeRef } from "./model";

export interface ResolvedEffectivePolicy {
    decision: Exclude<ReadDecision, "inherit">;
    decisionMatchedScope: ScopeRef | "mode-root";
    mentionPolicy: Exclude<MentionPolicy, "inherit">;
    mentionMatchedScope: ScopeRef | "global";
}

export function scopePath(context: ChannelContext): ScopeRef[] {
    if (context.kind === "unsupported") return [];
    if (context.kind !== "guild") {
        return [
            { scopeType: "dm", scopeId: context.channelId },
            { scopeType: "all-dms", scopeId: "all" },
        ];
    }
    const path: ScopeRef[] = [{ scopeType: "channel", scopeId: context.channelId }];
    if (
        context.thread &&
        context.parentChannelId &&
        context.parentChannelId !== context.channelId
    ) {
        path.push({ scopeType: "channel", scopeId: context.parentChannelId });
    }
    if (context.categoryId) path.push({ scopeType: "category", scopeId: context.categoryId });
    path.push({ scopeType: "guild", scopeId: context.guildId });
    return path;
}

export function evaluatePolicy(
    settings: SettingsV1,
    context: ChannelContext,
    mentionState: MentionState,
): PolicyOutcome {
    if (context.kind === "unsupported") return { kind: "unsupported-channel" };
    const path = scopePath(context);
    const effective = resolveEffectivePolicy(settings, path);
    if (effective.decision === "keep-unread")
        return { kind: "keep-unread", matchedScope: effective.decisionMatchedScope };
    if (effective.mentionPolicy === "protect") {
        if (!mentionState.available) return { kind: "missing-read-state" };
        if (mentionState.count > 0)
            return { kind: "protected-mention", matchedScope: effective.mentionMatchedScope };
    }
    return { kind: "auto-read", matchedScope: effective.decisionMatchedScope };
}

export function resolveEffectivePolicy(
    settings: SettingsV1,
    path: readonly ScopeRef[],
): ResolvedEffectivePolicy {
    const read = resolveRead(settings, path);
    const mention = resolveMention(settings, path);
    return {
        decision: read.decision,
        decisionMatchedScope: read.matchedScope,
        mentionPolicy: mention.policy,
        mentionMatchedScope: mention.matchedScope,
    };
}

function resolveRead(
    settings: SettingsV1,
    path: readonly ScopeRef[],
): { decision: Exclude<ReadDecision, "inherit">; matchedScope: ScopeRef | "mode-root" } {
    for (const scope of path) {
        const rule = settings.rules[ruleKey(scope.scopeType, scope.scopeId)];
        if (rule?.decision && rule.decision !== "inherit")
            return { decision: rule.decision, matchedScope: scope };
    }
    return {
        decision: settings.mode === "include" ? "keep-unread" : "auto-read",
        matchedScope: "mode-root",
    };
}

function resolveMention(
    settings: SettingsV1,
    path: readonly ScopeRef[],
): { policy: Exclude<MentionPolicy, "inherit">; matchedScope: ScopeRef | "global" } {
    for (const scope of path) {
        const rule: ScopeRule | undefined = settings.rules[ruleKey(scope.scopeType, scope.scopeId)];
        if (rule?.mentionPolicy && rule.mentionPolicy !== "inherit")
            return { policy: rule.mentionPolicy, matchedScope: scope };
    }
    return { policy: settings.globalMentionPolicy, matchedScope: "global" };
}
