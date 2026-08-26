import { evaluatePolicy } from "../policy/evaluate";
import type { ChannelContext, MentionState, PolicyOutcome } from "../policy/evaluate";
import type { SettingsV1 } from "../settings/model";

export const ACK_BATCH_SIZE = 50;

export interface AckEntry {
    channelId: string;
    messageId: string;
    readStateType: 0;
}

export interface AckCandidate {
    context: ChannelContext;
    messageId: string;
}

export interface SchedulerClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
    wait(delayMs: number): Promise<void>;
}

export interface SchedulerDependencies {
    getSettings(): Readonly<SettingsV1>;
    getMentionState(channelId: string): MentionState;
    bulkAck(entries: readonly AckEntry[]): void | Promise<void>;
    onOutcome(channelId: string, outcome: PolicyOutcome): void;
    onError(error: unknown): void;
    onPendingCountChange?(pendingCount: number): void;
    clock: SchedulerClock;
}

interface PendingAcknowledgement {
    candidate: AckCandidate;
    dueAt: number;
}

export function compareSnowflakes(left: string, right: string): number {
    const leftValue = parseSnowflake(left);
    const rightValue = parseSnowflake(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export class AckScheduler {
    private readonly pending = new Map<string, PendingAcknowledgement>();
    private readonly retryWaits = new Map<unknown, () => void>();
    private timer: unknown | undefined;
    private activeFlush: Promise<void> | undefined;
    private stopped = false;

    constructor(private readonly dependencies: SchedulerDependencies) {}

    get pendingCount(): number {
        return this.pending.size;
    }

    enqueue(candidate: AckCandidate): void {
        if (this.stopped) {
            return;
        }
        assertValidCandidate(candidate);

        const channelId = candidate.context.channelId;
        const previous = this.pending.get(channelId);
        const retainedCandidate =
            previous && compareSnowflakes(previous.candidate.messageId, candidate.messageId) > 0
                ? previous.candidate
                : candidate;

        this.pending.set(channelId, {
            candidate: retainedCandidate,
            dueAt: this.dependencies.clock.now() + this.dependencies.getSettings().debounceMs,
        });
        if (!previous) {
            this.dependencies.onPendingCountChange?.(this.pending.size);
        }
        this.armTimer();
    }

    async ackNow(candidates: readonly AckCandidate[]): Promise<void> {
        if (this.stopped) {
            return;
        }

        const retained = coalesceCandidates(candidates);
        await this.ackCandidates(retained);
    }

    flushDue(): Promise<void> {
        if (this.stopped) {
            return Promise.resolve();
        }
        if (this.activeFlush) {
            return this.activeFlush;
        }

        const activeFlush = this.flushDueEntries();
        this.activeFlush = activeFlush;
        void activeFlush.then(
            () => this.finishFlush(activeFlush),
            (error: unknown) => {
                this.reportAutomaticError(error);
                this.finishFlush(activeFlush);
            },
        );
        return activeFlush;
    }

    stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        const hadPending = this.pending.size > 0;
        this.pending.clear();
        if (hadPending) {
            this.dependencies.onPendingCountChange?.(0);
        }
        if (this.timer !== undefined) {
            this.dependencies.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
        for (const [handle, resolve] of this.retryWaits) {
            this.dependencies.clock.clearTimeout(handle);
            resolve();
        }
        this.retryWaits.clear();
    }

    private async flushDueEntries(): Promise<void> {
        if (this.stopped) {
            return;
        }

        const now = this.dependencies.clock.now();
        const candidates: AckCandidate[] = [];
        for (const [channelId, pending] of this.pending) {
            if (pending.dueAt <= now) {
                this.pending.delete(channelId);
                candidates.push(pending.candidate);
            }
        }
        if (candidates.length > 0) {
            this.dependencies.onPendingCountChange?.(this.pending.size);
        }
        await this.ackCandidates(candidates);
    }

    private async ackCandidates(candidates: readonly AckCandidate[]): Promise<void> {
        const eligible: AckEntry[] = [];
        const settings = this.dependencies.getSettings();

        for (const candidate of candidates) {
            if (this.stopped) {
                return;
            }
            const outcome = evaluatePolicy(
                settings as SettingsV1,
                candidate.context,
                this.dependencies.getMentionState(candidate.context.channelId),
            );
            this.dependencies.onOutcome(candidate.context.channelId, outcome);
            if (outcome.kind === "auto-read") {
                eligible.push({
                    channelId: candidate.context.channelId,
                    messageId: candidate.messageId,
                    readStateType: 0,
                });
            }
        }

        eligible.sort((left, right) => compareChannelIds(left.channelId, right.channelId));
        for (let index = 0; index < eligible.length; index += ACK_BATCH_SIZE) {
            if (this.stopped) {
                return;
            }
            await this.sendWithRetry(eligible.slice(index, index + ACK_BATCH_SIZE));
        }
    }

    private async sendWithRetry(entries: readonly AckEntry[]): Promise<void> {
        const retryDelays = [250, 1000];
        for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
            if (this.stopped) {
                return;
            }
            try {
                await this.dependencies.bulkAck(entries);
                return;
            } catch (error) {
                if (this.stopped) {
                    return;
                }
                if (attempt === retryDelays.length) {
                    throw error;
                }
                const delay = retryDelays[attempt];
                if (delay !== undefined) {
                    await this.waitForRetry(delay);
                }
            }
        }
    }

    private waitForRetry(delayMs: number): Promise<void> {
        return new Promise((resolve) => {
            let handle: unknown;
            const finish = () => {
                if (!this.retryWaits.delete(handle)) {
                    return;
                }
                resolve();
            };
            handle = this.dependencies.clock.setTimeout(finish, delayMs);
            this.retryWaits.set(handle, finish);
        });
    }

    private armTimer(): void {
        if (this.timer !== undefined) {
            this.dependencies.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.stopped) {
            return;
        }

        let nextDueAt: number | undefined;
        for (const pending of this.pending.values()) {
            if (nextDueAt === undefined || pending.dueAt < nextDueAt) {
                nextDueAt = pending.dueAt;
            }
        }
        if (nextDueAt === undefined) {
            return;
        }

        this.timer = this.dependencies.clock.setTimeout(
            () => {
                this.timer = undefined;
                void this.flushDue();
            },
            Math.max(0, nextDueAt - this.dependencies.clock.now()),
        );
    }

    private reportAutomaticError(error: unknown): void {
        if (this.stopped) {
            return;
        }
        try {
            this.dependencies.onError(error);
        } catch {
            // Error reporting must not create an unhandled scheduler rejection.
        }
    }

    private finishFlush(activeFlush: Promise<void>): void {
        if (this.activeFlush === activeFlush) {
            this.activeFlush = undefined;
        }
        if (!this.stopped) {
            this.armTimer();
        }
    }
}

function coalesceCandidates(candidates: readonly AckCandidate[]): AckCandidate[] {
    const retained = new Map<string, AckCandidate>();
    for (const candidate of candidates) {
        assertValidCandidate(candidate);
        const channelId = candidate.context.channelId;
        const previous = retained.get(channelId);
        if (!previous || compareSnowflakes(previous.messageId, candidate.messageId) <= 0) {
            retained.set(channelId, candidate);
        }
    }
    return [...retained.values()];
}

function assertValidCandidate(candidate: AckCandidate): void {
    parseSnowflake(candidate.messageId);
}

function parseSnowflake(value: string): bigint {
    if (!/^\d+$/.test(value)) {
        throw new TypeError("Snowflake IDs must contain only digits");
    }
    return BigInt(value);
}

function compareChannelIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
