import type { BdApiFacade } from "../betterdiscord";
import { ContextMenuController } from "../context-menus/controller";
import { createDiagnosticsReport } from "../diagnostics/report";
import {
    resolveDiscordAdapter,
    type AdapterEventErrorReporter,
    type AdapterHealth,
    type AdapterResolutionOptions,
    type DiscordAdapter,
} from "../discord/adapter";
import { PLUGIN_META } from "../meta";
import { evaluatePolicy, type PolicyOutcome } from "../policy/evaluate";
import { Reconciler, type ReconciliationPreview } from "../reconciliation/reconciler";
import { AckScheduler, type SchedulerClock } from "../scheduler/ack-scheduler";
import type { ScopeType } from "../settings/model";
import type { SettingsStore } from "../settings/store";
import { createSettingsPanel } from "../ui/settings-panel";

export const ADAPTER_RETRY_MS = 1000;
export const ADAPTER_MAX_ATTEMPTS = 30;
export const RUNTIME_ERROR_COOLDOWN_MS = 30_000;

type AdapterResolver = (
    api: BdApiFacade,
    options: AdapterResolutionOptions,
) => AdapterHealth | Promise<AdapterHealth>;

interface CleanupTask {
    code: string;
    cleanup: () => void;
    resource: RuntimeResource;
}

type RuntimeResource = "adapter-retry" | "message-subscription" | "context-menus" | "scheduler";

export interface RuntimeControllerOptions {
    clock?: SchedulerClock;
    resolveAdapter?: AdapterResolver;
}

const INITIAL_HEALTH: AdapterHealth = Object.freeze({ ok: false, missing: ["NotStarted"] });
const EMPTY_PREVIEW: ReconciliationPreview = Object.freeze({
    matched: Object.freeze([]),
    skipped: Object.freeze({
        "auto-read": 0,
        "keep-unread": 0,
        "protected-mention": 0,
        "missing-read-state": 0,
        "unsupported-channel": 0,
    }),
});

export class RuntimeController {
    private readonly clock: SchedulerClock;
    private readonly resolveAdapter: AdapterResolver;
    private generation = 0;
    private active = false;
    private retryTimer: unknown | undefined;
    private resolvingGeneration: number | undefined;
    private terminalToastGeneration: number | undefined;
    private health: AdapterHealth = INITIAL_HEALTH;
    private adapter: DiscordAdapter | undefined;
    private scheduler: AckScheduler | undefined;
    private reconciler: Reconciler | undefined;
    private menus: ContextMenuController | undefined;
    private unsubscribeMessages: (() => void) | undefined;
    private lastPolicyOutcome: PolicyOutcome["kind"] | undefined;
    private readonly errorLoggedAt = new Map<string, number>();
    private failedCleanups: CleanupTask[] = [];
    private runtimeVersion = 0;
    private readonly runtimeListeners = new Set<() => void>();

    constructor(
        private readonly api: BdApiFacade,
        private readonly settings: SettingsStore,
        options: RuntimeControllerOptions = {},
    ) {
        this.clock = options.clock ?? systemClock;
        this.resolveAdapter = options.resolveAdapter ?? resolveDiscordAdapter;
    }

    start(): void {
        if (this.active) {
            return;
        }
        this.retryFailedCleanups();
        if (this.failedCleanups.length > 0) {
            this.setHealth({ ok: false, missing: ["Cleanup"] });
            return;
        }

        this.active = true;
        const generation = ++this.generation;
        this.errorLoggedAt.clear();
        this.terminalToastGeneration = undefined;
        this.lastPolicyOutcome = undefined;
        this.setHealth({ ok: false, missing: ["Initializing"] });

        try {
            this.settings.load();
        } catch (error) {
            this.logError("settings-load", error);
        }

        void this.attemptAdapterResolution(generation, 1).catch((error: unknown) => {
            this.failStartup(generation, "AdapterResolver", "adapter-resolution", error);
        });
    }

    stop(): void {
        ++this.generation;
        this.active = false;
        this.resolvingGeneration = undefined;
        this.terminalToastGeneration = undefined;

        const retryTimer = this.retryTimer;
        this.retryTimer = undefined;
        const unsubscribeMessages = this.unsubscribeMessages;
        this.unsubscribeMessages = undefined;
        const menus = this.menus;
        this.menus = undefined;
        const scheduler = this.scheduler;
        this.scheduler = undefined;
        this.reconciler = undefined;
        this.adapter = undefined;
        this.retryFailedCleanups();

        if (retryTimer !== undefined) {
            this.runCleanup(
                "cleanup-adapter-retry",
                () => this.clock.clearTimeout(retryTimer),
                "adapter-retry",
            );
        }
        if (unsubscribeMessages) {
            this.runCleanup(
                "cleanup-message-subscription",
                unsubscribeMessages,
                "message-subscription",
            );
        }
        if (menus) {
            this.runCleanup("cleanup-context-menus", () => menus.stop(), "context-menus");
        }
        if (scheduler) {
            this.runCleanup("cleanup-scheduler", () => scheduler.stop(), "scheduler");
        }
        this.setHealth(
            this.failedCleanups.length > 0
                ? { ok: false, missing: ["Cleanup"] }
                : { ok: false, missing: ["Stopped"] },
        );
    }

    getHealth(): AdapterHealth {
        return this.health;
    }

    getPendingCount(): number {
        return this.scheduler?.pendingCount ?? 0;
    }

    getDiagnosticsJson(): string {
        const settings = this.settings.snapshot;
        return `${JSON.stringify(
            createDiagnosticsReport({
                pluginVersion: PLUGIN_META.version,
                betterDiscordVersion: getBetterDiscordVersion(),
                adapter: {
                    available: this.health.ok,
                    messageSubscriptionActive:
                        this.unsubscribeMessages !== undefined ||
                        this.failedCleanups.some(
                            (task) => task.resource === "message-subscription",
                        ),
                    acknowledgementAvailable: this.health.ok,
                },
                mode: settings.mode,
                debounceMs: settings.debounceMs,
                reconcileOnStart: settings.reconcileOnStart,
                globalMentionPolicy: settings.globalMentionPolicy,
                ruleCounts: countRules(settings.rules),
                pendingAcknowledgementCount: this.getPendingCount(),
                lastPolicyOutcome: this.lastPolicyOutcome,
            }),
            null,
            2,
        )}\n`;
    }

    createSettingsPanel(): import("react").ReactElement {
        return createSettingsPanel({
            api: this.api,
            settings: this.settings,
            getRuntimeVersion: () => this.runtimeVersion,
            subscribeRuntime: (listener) => this.subscribeRuntime(listener),
            getCatalog: () => this.getCatalog(),
            getDiagnosticsJson: () => this.getDiagnosticsJson(),
            preview: () => this.previewReconciliation(),
            apply: (preview) => this.applyReconciliation(preview),
        });
    }

    private async attemptAdapterResolution(generation: number, attempt: number): Promise<void> {
        if (!this.isCurrent(generation) || this.resolvingGeneration === generation) {
            return;
        }

        this.resolvingGeneration = generation;
        let health: AdapterHealth;
        try {
            const onEventError: AdapterEventErrorReporter = (code, error) => {
                if (this.isCurrent(generation)) {
                    this.logError(code, error);
                }
            };
            health = await this.resolveAdapter(this.api, { onEventError });
        } catch (error) {
            if (!this.isCurrent(generation)) {
                return;
            }
            this.logError("adapter-resolution", error);
            health = { ok: false, missing: ["AdapterResolver"] };
        } finally {
            if (this.resolvingGeneration === generation) {
                this.resolvingGeneration = undefined;
            }
        }

        if (!this.isCurrent(generation)) {
            return;
        }
        this.setHealth(health);
        if (health.ok) {
            this.startEngine(generation, health.adapter);
            return;
        }
        if (attempt >= ADAPTER_MAX_ATTEMPTS) {
            this.showTerminalToast(generation);
            return;
        }

        let timer: unknown;
        timer = this.clock.setTimeout(() => {
            if (this.retryTimer !== timer) {
                return;
            }
            this.retryTimer = undefined;
            if (!this.isCurrent(generation)) {
                return;
            }
            void this.attemptAdapterResolution(generation, attempt + 1).catch((error: unknown) => {
                this.failStartup(generation, "AdapterResolver", "adapter-resolution", error);
            });
        }, ADAPTER_RETRY_MS);
        this.retryTimer = timer;
    }

    private startEngine(generation: number, adapter: DiscordAdapter): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        const scheduler = new AckScheduler({
            getSettings: () => this.settings.snapshot,
            getMentionState: (channelId) => adapter.getMentionState(channelId),
            bulkAck: (entries) => adapter.bulkAck(entries),
            onOutcome: (_channelId, outcome) => {
                if (this.isCurrent(generation)) {
                    this.lastPolicyOutcome = outcome.kind;
                }
            },
            onError: (error) => this.logError("scheduler", error),
            onPendingCountChange: () => {
                if (this.isCurrent(generation)) {
                    this.signalRuntimeChange();
                }
            },
            clock: this.clock,
        });
        const reconciler = new Reconciler({ adapter, scheduler, settings: this.settings });
        const menus = new ContextMenuController(this.api, adapter, this.settings);
        let unsubscribeMessages: (() => void) | undefined;

        try {
            unsubscribeMessages = adapter.subscribeToMessages((event) => {
                this.handleMessage(generation, adapter, scheduler, event);
            });
            if (!this.isCurrent(generation)) {
                throw staleStartup;
            }
            menus.start();
            if (!this.isCurrent(generation)) {
                throw staleStartup;
            }

            this.adapter = adapter;
            this.scheduler = scheduler;
            this.reconciler = reconciler;
            this.menus = menus;
            this.unsubscribeMessages = unsubscribeMessages;
            this.setHealth({ ok: true, adapter });
        } catch (error) {
            if (unsubscribeMessages) {
                this.runCleanup(
                    "cleanup-message-subscription",
                    unsubscribeMessages,
                    "message-subscription",
                );
            }
            this.runCleanup("cleanup-context-menus", () => menus.stop(), "context-menus");
            this.runCleanup("cleanup-scheduler", () => scheduler.stop(), "scheduler");
            if (error !== staleStartup) {
                this.failStartup(generation, "Runtime", "engine-startup", error);
            }
            return;
        }

        if (this.settings.snapshot.reconcileOnStart) {
            void Promise.resolve()
                .then(async () => {
                    if (!this.isCurrent(generation) || this.reconciler !== reconciler) {
                        return;
                    }
                    await reconciler.apply(reconciler.preview());
                })
                .catch((error: unknown) => this.logError("startup-reconciliation", error));
        }
    }

    private handleMessage(
        generation: number,
        adapter: DiscordAdapter,
        scheduler: AckScheduler,
        event: unknown,
    ): void {
        if (!this.isCurrent(generation) || this.scheduler !== scheduler) {
            return;
        }
        let message: ReturnType<typeof parseMessageEvent>;
        try {
            message = parseMessageEvent(event);
        } catch (error) {
            this.logError("message-shape", error);
            return;
        }
        if (!message) {
            return;
        }

        let currentUserId: string | undefined;
        try {
            currentUserId = adapter.getCurrentUserId();
        } catch (error) {
            this.logError("current-user", error);
            return;
        }
        if (!isNonEmptyString(currentUserId) || message.authorId === currentUserId) {
            return;
        }

        try {
            const context = adapter.getChannelContext(message.channelId);
            const outcome = evaluatePolicy(
                this.settings.snapshot,
                context,
                adapter.getMentionState(message.channelId),
            );
            this.lastPolicyOutcome = outcome.kind;
            if (outcome.kind === "auto-read") {
                scheduler.enqueue({ context, messageId: message.messageId });
            }
        } catch (error) {
            this.logError("message-context", error);
        }
    }

    private getCatalog() {
        try {
            return this.adapter?.listScopeCatalog() ?? [];
        } catch (error) {
            this.logError("scope-catalog", error);
            return [];
        }
    }

    private previewReconciliation(): ReconciliationPreview {
        try {
            return this.reconciler?.preview() ?? EMPTY_PREVIEW;
        } catch (error) {
            this.logError("reconciliation-preview", error);
            return EMPTY_PREVIEW;
        }
    }

    private applyReconciliation(preview: ReconciliationPreview): Promise<void> {
        const reconciler = this.reconciler;
        if (!reconciler) {
            return Promise.resolve();
        }
        try {
            return Promise.resolve(reconciler.apply(preview)).catch((error: unknown) => {
                this.logError("reconciliation-apply", error);
                throw error;
            });
        } catch (error) {
            this.logError("reconciliation-apply", error);
            return Promise.reject(error);
        }
    }

    private isCurrent(generation: number): boolean {
        return this.active && this.generation === generation;
    }

    private failStartup(generation: number, missing: string, code: string, error: unknown): void {
        if (!this.isCurrent(generation)) {
            return;
        }
        this.setHealth({ ok: false, missing: [missing] });
        this.logError(code, error);
        this.showTerminalToast(generation);
    }

    private showTerminalToast(generation: number): void {
        if (!this.isCurrent(generation) || this.terminalToastGeneration === generation) {
            return;
        }
        this.terminalToastGeneration = generation;
        this.signalRuntimeChange();
        try {
            const missing = this.health.ok ? ["Unknown"] : this.health.missing;
            const moduleLabel = missing.length === 1 ? "module" : "modules";
            this.api.UI.showToast(
                `Smart Auto Read could not start. Missing Discord ${moduleLabel}: ${missing.join(", ")}.`,
                { type: "error" },
            );
        } catch (error) {
            this.logError("startup-toast", error);
        }
    }

    private runCleanup(code: string, cleanup: () => void, resource: RuntimeResource): void {
        try {
            cleanup();
        } catch (error) {
            this.logError(code, error);
            this.failedCleanups.push({ code, cleanup, resource });
        }
    }

    private retryFailedCleanups(): void {
        const failedCleanups = this.failedCleanups;
        this.failedCleanups = [];
        for (const task of failedCleanups) {
            this.runCleanup(task.code, task.cleanup, task.resource);
        }
    }

    private setHealth(health: AdapterHealth): void {
        this.health = health;
        this.signalRuntimeChange();
    }

    private subscribeRuntime(listener: () => void): () => void {
        this.runtimeListeners.add(listener);
        return () => this.runtimeListeners.delete(listener);
    }

    private signalRuntimeChange(): void {
        this.runtimeVersion += 1;
        for (const listener of [...this.runtimeListeners]) {
            try {
                listener();
            } catch (error) {
                this.logError("runtime-listener", error);
            }
        }
    }

    private logError(code: string, error: unknown): void {
        const now = this.clock.now();
        const lastLoggedAt = this.errorLoggedAt.get(code);
        if (
            lastLoggedAt !== undefined &&
            now >= lastLoggedAt &&
            now - lastLoggedAt < RUNTIME_ERROR_COOLDOWN_MS
        ) {
            return;
        }
        this.errorLoggedAt.set(code, now);
        try {
            this.api.Logger.error(code, error);
        } catch {
            // Runtime logging must never interrupt the plugin lifecycle.
        }
    }
}

const staleStartup = Object.freeze({ code: "stale-startup" });

const systemClock: SchedulerClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    wait: (delayMs) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
};

function parseMessageEvent(
    event: unknown,
): { channelId: string; messageId: string; authorId: string } | undefined {
    if (!isRecord(event) || !isRecord(event.message)) {
        return undefined;
    }
    const message = event.message;
    if (
        !isNonEmptyString(message.channel_id) ||
        !isSnowflake(message.id) ||
        !isRecord(message.author) ||
        !isNonEmptyString(message.author.id)
    ) {
        return undefined;
    }
    return {
        channelId: message.channel_id,
        messageId: message.id,
        authorId: message.author.id,
    };
}

function countRules(
    rules: Readonly<Record<string, { scopeType: ScopeType }>>,
): Record<ScopeType, number> {
    const counts: Record<ScopeType, number> = {
        "all-dms": 0,
        dm: 0,
        guild: 0,
        category: 0,
        channel: 0,
    };
    for (const rule of Object.values(rules)) {
        counts[rule.scopeType] += 1;
    }
    return counts;
}

function getBetterDiscordVersion(): string {
    const bdApiGlobal = Reflect.get(globalThis, "BdApi");
    if (
        (typeof bdApiGlobal === "object" || typeof bdApiGlobal === "function") &&
        bdApiGlobal !== null
    ) {
        const version = Reflect.get(bdApiGlobal, "version");
        if (isNonEmptyString(version)) {
            return version;
        }
    }
    return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
}
