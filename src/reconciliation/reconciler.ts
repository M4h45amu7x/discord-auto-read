import type { DiscordAdapter } from "../discord/adapter";
import { evaluatePolicy } from "../policy/evaluate";
import type { ChannelContext, PolicyOutcome } from "../policy/evaluate";
import {
    compareSnowflakes,
    type AckCandidate,
    type AckScheduler,
} from "../scheduler/ack-scheduler";
import type { SettingsStore } from "../settings/store";

export interface ReconciliationPreview {
    matched: readonly AckCandidate[];
    skipped: Readonly<Record<PolicyOutcome["kind"], number>>;
}

export interface ReconcilerDependencies {
    adapter: Pick<DiscordAdapter, "getMentionState" | "listUnreadCandidates">;
    scheduler: Pick<AckScheduler, "ackNow">;
    settings: Pick<SettingsStore, "snapshot">;
}

export class Reconciler {
    constructor(private readonly dependencies: ReconcilerDependencies) {}

    preview(): ReconciliationPreview {
        const matched = new Map<string, AckCandidate>();
        const skipped = createOutcomeCounts();

        for (const candidate of this.dependencies.adapter.listUnreadCandidates()) {
            const outcome = evaluatePolicy(
                this.dependencies.settings.snapshot,
                candidate.context,
                this.dependencies.adapter.getMentionState(candidate.context.channelId),
            );
            if (outcome.kind === "auto-read") {
                const snapshot = snapshotCandidate(candidate);
                const previous = matched.get(snapshot.context.channelId);
                if (!previous || compareSnowflakes(previous.messageId, snapshot.messageId) <= 0) {
                    matched.set(snapshot.context.channelId, snapshot);
                }
            } else {
                skipped[outcome.kind] += 1;
            }
        }

        const candidates = [...matched.values()].sort(compareCandidates);
        return Object.freeze({
            matched: Object.freeze(candidates),
            skipped: Object.freeze(skipped),
        });
    }

    apply(preview: ReconciliationPreview): Promise<void> {
        return this.dependencies.scheduler.ackNow(preview.matched.map(snapshotCandidate));
    }
}

function createOutcomeCounts(): Record<PolicyOutcome["kind"], number> {
    return {
        "auto-read": 0,
        "keep-unread": 0,
        "protected-mention": 0,
        "missing-read-state": 0,
        "unsupported-channel": 0,
    };
}

function compareCandidates(left: AckCandidate, right: AckCandidate): number {
    const leftChannelId = left.context.channelId;
    const rightChannelId = right.context.channelId;
    if (leftChannelId !== rightChannelId) {
        return leftChannelId < rightChannelId ? -1 : 1;
    }
    if (left.messageId === right.messageId) {
        return 0;
    }
    return left.messageId < right.messageId ? -1 : 1;
}

function snapshotCandidate(candidate: AckCandidate): AckCandidate {
    return Object.freeze({
        context: snapshotContext(candidate.context),
        messageId: candidate.messageId,
    });
}

function snapshotContext(context: ChannelContext): ChannelContext {
    switch (context.kind) {
        case "guild":
            return Object.freeze({ ...context });
        case "dm":
        case "group-dm":
        case "unsupported":
            return Object.freeze({ ...context });
    }
}
