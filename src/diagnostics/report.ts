import type { PolicyOutcome } from "../policy/evaluate";
import type { MentionPolicy, Mode, ScopeType } from "../settings/model";

export interface RuntimeDiagnostics {
    pluginVersion: string;
    betterDiscordVersion: string;
    adapter: {
        available: boolean;
        messageSubscriptionActive: boolean;
        acknowledgementAvailable: boolean;
    };
    mode: Mode;
    debounceMs: number;
    reconcileOnStart: boolean;
    globalMentionPolicy: Exclude<MentionPolicy, "inherit">;
    ruleCounts: Readonly<Record<ScopeType, number>>;
    pendingAcknowledgementCount: number;
    lastPolicyOutcome: PolicyOutcome["kind"] | undefined;
}

export interface DiagnosticsReport {
    pluginVersion: string;
    betterDiscordVersion: string;
    adapter: RuntimeDiagnostics["adapter"];
    mode: Mode;
    debounceMs: number;
    reconcileOnStart: boolean;
    globalMentionPolicy: Exclude<MentionPolicy, "inherit">;
    ruleCounts: Readonly<Record<ScopeType, number>>;
    pendingAcknowledgementCount: number;
    lastPolicyOutcome: PolicyOutcome["kind"] | undefined;
}

export function createDiagnosticsReport(input: RuntimeDiagnostics): DiagnosticsReport {
    return {
        pluginVersion: input.pluginVersion,
        betterDiscordVersion: input.betterDiscordVersion,
        adapter: {
            available: input.adapter.available,
            messageSubscriptionActive: input.adapter.messageSubscriptionActive,
            acknowledgementAvailable: input.adapter.acknowledgementAvailable,
        },
        mode: input.mode,
        debounceMs: input.debounceMs,
        reconcileOnStart: input.reconcileOnStart,
        globalMentionPolicy: input.globalMentionPolicy,
        ruleCounts: {
            "all-dms": input.ruleCounts["all-dms"],
            dm: input.ruleCounts.dm,
            guild: input.ruleCounts.guild,
            category: input.ruleCounts.category,
            channel: input.ruleCounts.channel,
        },
        pendingAcknowledgementCount: input.pendingAcknowledgementCount,
        lastPolicyOutcome: input.lastPolicyOutcome,
    };
}
