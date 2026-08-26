import type { BdApiFacade } from "../betterdiscord";
import type { ChannelContext, MentionState, ScopeRef } from "../policy/model";
import type { AckEntry } from "../scheduler/ack-scheduler";

export interface MessageCreateEvent {
    message: {
        id: string;
        channel_id: string;
        author: { id: string };
    };
}

export interface ScopeCatalogNode {
    scope: ScopeRef;
    label: string;
    imageUrl?: string;
    kind?: ScopePresentationKind;
    position?: number;
    children: readonly ScopeCatalogNode[];
}

export type ScopePresentationKind =
    | "all-dms"
    | "dm"
    | "group-dm"
    | "guild"
    | "category"
    | "channel"
    | "thread";

export interface UnreadCandidate {
    context: ChannelContext;
    messageId: string;
}

export interface DiscordAdapter {
    subscribeToMessages(listener: (event: MessageCreateEvent) => void): () => void;
    getCurrentUserId(): string | undefined;
    getChannelContext(channelId: string): ChannelContext;
    findPrivateChannelIdForUser(userId: string): string | undefined;
    getMentionState(channelId: string): MentionState;
    listScopeCatalog(): readonly ScopeCatalogNode[];
    listUnreadCandidates(): readonly UnreadCandidate[];
    bulkAck(entries: readonly AckEntry[]): void | Promise<void>;
}

export const ADAPTER_EVENT_ERROR_CODE = "adapter-event";
export type AdapterEventErrorCode = typeof ADAPTER_EVENT_ERROR_CODE;
export type AdapterEventErrorReporter = (code: AdapterEventErrorCode, error: unknown) => void;

export interface AdapterResolutionOptions {
    readonly onEventError?: AdapterEventErrorReporter;
}

export type AdapterHealth =
    | { ok: true; adapter: DiscordAdapter }
    | { ok: false; missing: readonly string[] };

interface Dispatcher {
    subscribe(type: string, listener: (event: unknown) => void): void;
    unsubscribe(type: string, listener: (event: unknown) => void): void;
    dispatch(event: unknown): void;
}

interface ChannelStore {
    getChannel(channelId: string): unknown;
}

interface GuildStore {
    getGuilds(): unknown;
}

interface GuildChannelStore {
    getChannels(guildId: string): unknown;
}

interface PrivateChannelSortStore {
    getPrivateChannelIds(): unknown;
}

interface ReadStateStore {
    hasUnread(channelId: string): unknown;
    getMentionCount(channelId: string): unknown;
    lastMessageId(channelId: string): unknown;
}

interface UserStore {
    getCurrentUser(): unknown;
    getUser?(userId: string): unknown;
}

interface ChannelRecord extends Record<string, unknown> {
    id: string;
    type?: number;
    name?: string;
    guild_id?: string;
    parent_id?: string | null;
    position?: number;
    recipients?: readonly string[];
}

interface GuildRecord extends Record<string, unknown> {
    id: string;
    name: string;
    icon?: string | null;
}

interface ResolvedModules {
    onEventError: AdapterEventErrorReporter;
    dispatcher: Dispatcher;
    channelStore: ChannelStore;
    guildStore: GuildStore;
    guildChannelStore: GuildChannelStore;
    privateChannelSortStore: PrivateChannelSortStore;
    readStateStore: ReadStateStore;
    userStore: UserStore;
}

enum DiscordChannelType {
    GuildText = 0,
    Dm = 1,
    GuildVoice = 2,
    GroupDm = 3,
    GuildCategory = 4,
    GuildAnnouncement = 5,
    AnnouncementThread = 10,
    PublicThread = 11,
    PrivateThread = 12,
    GuildStageVoice = 13,
    GuildForum = 15,
    GuildMedia = 16,
}

const SUPPORTED_GUILD_CHANNEL_TYPES = new Set<number>([
    DiscordChannelType.GuildText,
    DiscordChannelType.GuildAnnouncement,
]);
const SUPPORTED_THREAD_PARENT_TYPES = new Set<number>([
    ...SUPPORTED_GUILD_CHANNEL_TYPES,
    DiscordChannelType.GuildForum,
    DiscordChannelType.GuildMedia,
]);

export function resolveDiscordAdapter(
    api: BdApiFacade,
    options: AdapterResolutionOptions = {},
): AdapterHealth {
    const dispatcher = asDispatcher(
        safeCall(() =>
            api.Webpack.getByKeys("subscribe", "unsubscribe", "dispatch", {
                searchExports: true,
            }),
        ),
    );
    const channelStore = asChannelStore(safeCall(() => api.Webpack.getStore("ChannelStore")));
    const guildStore = asGuildStore(safeCall(() => api.Webpack.getStore("GuildStore")));
    const guildChannelStore = asGuildChannelStore(
        safeCall(() => api.Webpack.getStore("GuildChannelStore")),
    );
    const privateChannelSortStore = asPrivateChannelSortStore(
        safeCall(() => api.Webpack.getStore("PrivateChannelSortStore")),
    );
    const readStateStore = asReadStateStore(safeCall(() => api.Webpack.getStore("ReadStateStore")));
    const userStore = asUserStore(safeCall(() => api.Webpack.getStore("UserStore")));
    const missing: string[] = [];
    if (!dispatcher) missing.push("Dispatcher");
    if (!channelStore) missing.push("ChannelStore");
    if (!guildStore) missing.push("GuildStore");
    if (!guildChannelStore) missing.push("GuildChannelStore");
    if (!privateChannelSortStore) missing.push("PrivateChannelSortStore");
    if (!readStateStore) missing.push("ReadStateStore");
    if (!userStore) missing.push("UserStore");
    if (
        !dispatcher ||
        !channelStore ||
        !guildStore ||
        !guildChannelStore ||
        !privateChannelSortStore ||
        !readStateStore ||
        !userStore
    ) {
        return { ok: false, missing: missing.sort() };
    }

    return {
        ok: true,
        adapter: new ResolvedDiscordAdapter({
            onEventError: options.onEventError ?? ignoreAdapterEventError,
            dispatcher,
            channelStore,
            guildStore,
            guildChannelStore,
            privateChannelSortStore,
            readStateStore,
            userStore,
        }),
    };
}

class ResolvedDiscordAdapter implements DiscordAdapter {
    constructor(private readonly modules: ResolvedModules) {}

    subscribeToMessages(listener: (event: MessageCreateEvent) => void): () => void {
        const onMessage = (value: unknown) => {
            try {
                const event = parseMessageCreateEvent(value);
                if (event) {
                    listener(event);
                }
            } catch (error) {
                reportAdapterEventError(this.modules.onEventError, error);
            }
        };
        this.modules.dispatcher.subscribe("MESSAGE_CREATE", onMessage);
        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }
            this.modules.dispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
            subscribed = false;
        };
    }

    getCurrentUserId(): string | undefined {
        const user = safeCall(() => this.modules.userStore.getCurrentUser());
        if (!isRecord(user) || !isNonEmptyString(user.id)) {
            return undefined;
        }
        return user.id;
    }

    getChannelContext(channelId: string): ChannelContext {
        const channel = this.getChannel(channelId);
        if (!channel) {
            return { kind: "unsupported", channelId };
        }
        const dmPredicate = channelPredicate(channel, "isDM");
        const groupDmPredicate = channelPredicate(channel, "isGroupDM");
        const threadPredicate = channelPredicate(channel, "isThread");
        if (dmPredicate === true) {
            return { kind: "dm", channelId };
        }
        if (groupDmPredicate === true) {
            return { kind: "group-dm", channelId };
        }
        if (threadPredicate === true) {
            return this.createThreadContext(channelId, channel);
        }

        const thread =
            threadPredicate === undefined &&
            typeMatches(
                channel,
                DiscordChannelType.AnnouncementThread,
                DiscordChannelType.PublicThread,
                DiscordChannelType.PrivateThread,
            );
        if (dmPredicate === undefined && typeMatches(channel, DiscordChannelType.Dm)) {
            return { kind: "dm", channelId };
        }
        if (groupDmPredicate === undefined && typeMatches(channel, DiscordChannelType.GroupDm)) {
            return { kind: "group-dm", channelId };
        }
        if (!isNonEmptyString(channel.guild_id)) {
            return { kind: "unsupported", channelId };
        }

        if (!thread) {
            if (
                typeof channel.type !== "number" ||
                !SUPPORTED_GUILD_CHANNEL_TYPES.has(channel.type)
            ) {
                return { kind: "unsupported", channelId };
            }
            const category = this.resolveCategory(channel.parent_id, channel.guild_id);
            if (!category.ok) {
                return { kind: "unsupported", channelId };
            }
            return {
                kind: "guild",
                channelId,
                guildId: channel.guild_id,
                ...(category.categoryId ? { categoryId: category.categoryId } : {}),
                thread: false,
            };
        }

        return this.createThreadContext(channelId, channel);
    }

    getMentionState(channelId: string): MentionState {
        const count = safeCall(() => this.modules.readStateStore.getMentionCount(channelId));
        if (!isNonNegativeInteger(count)) {
            return { available: false, count: 0 };
        }
        return { available: true, count };
    }

    findPrivateChannelIdForUser(userId: string): string | undefined {
        if (!isNonEmptyString(userId)) {
            return undefined;
        }
        return this.getPrivateChannelIds().find((channelId) => {
            const channel = this.getChannel(channelId);
            return (
                channel !== undefined &&
                this.getChannelContext(channelId).kind === "dm" &&
                Array.isArray(channel.recipients) &&
                channel.recipients.some((recipientId) => recipientId === userId)
            );
        });
    }

    listScopeCatalog(): readonly ScopeCatalogNode[] {
        const roots: ScopeCatalogNode[] = [];
        const privateNodes = this.getPrivateChannelIds().flatMap((channelId, position) => {
            const channel = this.getChannel(channelId);
            const context = this.getChannelContext(channelId);
            if (!channel || (context.kind !== "dm" && context.kind !== "group-dm")) {
                return [];
            }
            const identity = this.getPrivateChannelIdentity(channel, context.kind);
            return [
                {
                    ...createCatalogNode(
                        { scopeType: "dm", scopeId: channelId },
                        identity.label,
                        position,
                    ),
                    kind: context.kind,
                    ...(identity.imageUrl ? { imageUrl: identity.imageUrl } : {}),
                },
            ];
        });
        if (privateNodes.length > 0) {
            roots.push({
                scope: { scopeType: "all-dms", scopeId: "all" },
                label: "Direct Messages",
                kind: "all-dms",
                children: privateNodes,
            });
        }

        for (const guild of this.getGuilds()) {
            const imageUrl = guildImageUrl(guild);
            roots.push({
                scope: { scopeType: "guild", scopeId: guild.id },
                label: guild.name,
                kind: "guild",
                ...(imageUrl ? { imageUrl } : {}),
                children: buildGuildCatalog(guild.id, this.getGuildChannels(guild.id), (id) =>
                    this.getChannelContext(id),
                ),
            });
        }
        return roots;
    }

    listUnreadCandidates(): readonly UnreadCandidate[] {
        const candidates: UnreadCandidate[] = [];
        const seen = new Set<string>();
        const channels = [
            ...this.getPrivateChannelIds().map((id) => this.getChannel(id)),
            ...this.getGuilds().flatMap((guild) => this.getGuildChannels(guild.id)),
        ];
        for (const channel of channels) {
            if (!channel || seen.has(channel.id)) {
                continue;
            }
            seen.add(channel.id);
            const context = this.getChannelContext(channel.id);
            if (context.kind === "unsupported") {
                continue;
            }
            const unread =
                safeCall(() => this.modules.readStateStore.hasUnread(channel.id)) === true;
            const mentionCount = safeCall(() =>
                this.modules.readStateStore.getMentionCount(channel.id),
            );
            if (!unread && !(isNonNegativeInteger(mentionCount) && mentionCount > 0)) {
                continue;
            }
            const messageId = safeCall(() => this.modules.readStateStore.lastMessageId(channel.id));
            if (!isSnowflake(messageId)) {
                continue;
            }
            candidates.push({ context, messageId });
        }
        return candidates;
    }

    bulkAck(entries: readonly AckEntry[]): void {
        this.modules.dispatcher.dispatch({
            type: "BULK_ACK",
            context: "APP",
            channels: entries,
        });
    }

    private getChannel(channelId: string): ChannelRecord | undefined {
        return asChannelRecord(
            safeCall(() => this.modules.channelStore.getChannel(channelId)),
            channelId,
        );
    }

    private getPrivateChannelIds(): string[] {
        const value = safeCall(() => this.modules.privateChannelSortStore.getPrivateChannelIds());
        if (!Array.isArray(value)) {
            return [];
        }
        return [...new Set(value.filter(isNonEmptyString))];
    }

    private getGuilds(): GuildRecord[] {
        const value = safeCall(() => this.modules.guildStore.getGuilds());
        if (!isRecord(value)) {
            return [];
        }
        const seen = new Set<string>();
        return Object.values(value).flatMap((guild) => {
            if (!isRecord(guild) || !isNonEmptyString(guild.id) || !isNonEmptyString(guild.name)) {
                return [];
            }
            if (seen.has(guild.id)) {
                return [];
            }
            seen.add(guild.id);
            return [guild as GuildRecord];
        });
    }

    private getGuildChannels(guildId: string): ChannelRecord[] {
        const value = safeCall(() => this.modules.guildChannelStore.getChannels(guildId));
        return collectChannelRecords(value).filter((channel) => channel.guild_id === guildId);
    }

    private getPrivateChannelIdentity(
        channel: ChannelRecord,
        kind: "dm" | "group-dm",
    ): { label: string; imageUrl?: string } {
        if (kind === "group-dm") {
            const imageUrl = recordImageUrl(channel, "getIconURL");
            return {
                label: channelLabel(channel),
                ...(imageUrl ? { imageUrl } : {}),
            };
        }

        const currentUserId = this.getCurrentUserId();
        const recipientId = Array.isArray(channel.recipients)
            ? channel.recipients.find((value) => isNonEmptyString(value) && value !== currentUserId)
            : undefined;
        const user = recipientId
            ? safeCall(() => this.modules.userStore.getUser?.(recipientId))
            : undefined;
        if (!isRecord(user)) {
            return { label: channelLabel(channel) };
        }
        const imageUrl = recordImageUrl(user, "getAvatarURL");
        return {
            label: userDisplayName(user) ?? channelLabel(channel),
            ...(imageUrl ? { imageUrl } : {}),
        };
    }

    private createThreadContext(channelId: string, channel: ChannelRecord): ChannelContext {
        if (!isNonEmptyString(channel.guild_id)) {
            return { kind: "unsupported", channelId };
        }
        const ancestry = this.resolveThreadAncestry(channel, channel.guild_id);
        if (!ancestry) {
            return { kind: "unsupported", channelId };
        }
        return {
            kind: "guild",
            channelId,
            guildId: channel.guild_id,
            ...ancestry,
            thread: true,
        };
    }

    private resolveThreadAncestry(
        thread: ChannelRecord,
        guildId: string,
    ): { parentChannelId: string; categoryId?: string } | undefined {
        if (!isNonEmptyString(thread.parent_id)) {
            return undefined;
        }
        const parent = this.getChannel(thread.parent_id);
        if (
            !parent ||
            parent.guild_id !== guildId ||
            typeof parent.type !== "number" ||
            !SUPPORTED_THREAD_PARENT_TYPES.has(parent.type)
        ) {
            return undefined;
        }
        const category = this.resolveCategory(parent.parent_id, guildId);
        if (!category.ok) {
            return undefined;
        }
        return {
            parentChannelId: parent.id,
            ...(category.categoryId ? { categoryId: category.categoryId } : {}),
        };
    }

    private resolveCategory(
        categoryId: unknown,
        guildId: string,
    ): { ok: true; categoryId?: string } | { ok: false } {
        if (categoryId === undefined || categoryId === null) {
            return { ok: true };
        }
        if (!isNonEmptyString(categoryId)) {
            return { ok: false };
        }
        const category = this.getChannel(categoryId);
        if (
            !category ||
            category.guild_id !== guildId ||
            category.type !== DiscordChannelType.GuildCategory
        ) {
            return { ok: false };
        }
        return { ok: true, categoryId: category.id };
    }
}

function buildGuildCatalog(
    guildId: string,
    channels: readonly ChannelRecord[],
    getContext: (channelId: string) => ChannelContext,
): ScopeCatalogNode[] {
    const categoryNodes = new Map<string, ScopeCatalogNode>();
    const channelNodes = new Map<string, ScopeCatalogNode>();
    const roots: ScopeCatalogNode[] = [];

    for (const [index, channel] of channels.entries()) {
        if (channel.type === DiscordChannelType.GuildCategory) {
            categoryNodes.set(
                channel.id,
                createCatalogNode(
                    { scopeType: "category", scopeId: channel.id },
                    channelLabel(channel),
                    channelPosition(channel, index),
                    "category",
                ),
            );
            continue;
        }
        const context = getContext(channel.id);
        if (context.kind !== "guild" || context.guildId !== guildId) {
            continue;
        }
        channelNodes.set(
            channel.id,
            createCatalogNode(
                { scopeType: "channel", scopeId: channel.id },
                channelLabel(channel),
                channelPosition(channel, index),
                context.thread ? "thread" : "channel",
            ),
        );
    }

    for (const channel of channels) {
        const node = channelNodes.get(channel.id);
        if (!node) {
            continue;
        }
        const context = getContext(channel.id);
        if (context.kind !== "guild") {
            continue;
        }
        if (context.thread && context.parentChannelId) {
            const parent = channelNodes.get(context.parentChannelId);
            if (parent) {
                (parent.children as ScopeCatalogNode[]).push(node);
                continue;
            }
        }
        const category = context.categoryId ? categoryNodes.get(context.categoryId) : undefined;
        if (category) {
            (category.children as ScopeCatalogNode[]).push(node);
        } else {
            roots.push(node);
        }
    }

    for (const channel of channels) {
        const category = categoryNodes.get(channel.id);
        if (category) {
            roots.push(category);
        }
    }
    return roots;
}

function createCatalogNode(
    scope: ScopeRef,
    label: string,
    position?: number,
    kind?: ScopePresentationKind,
): ScopeCatalogNode {
    return {
        scope,
        label,
        ...(kind ? { kind } : {}),
        ...(position === undefined ? {} : { position }),
        children: [],
    };
}

function collectChannelRecords(value: unknown): ChannelRecord[] {
    const collected: ChannelRecord[] = [];
    const seen = new Set<string>();
    const visited = new Set<object>();
    const visit = (candidate: unknown) => {
        if (Array.isArray(candidate)) {
            if (visited.has(candidate)) {
                return;
            }
            visited.add(candidate);
            for (const item of candidate) visit(item);
            return;
        }
        if (!isRecord(candidate)) {
            return;
        }
        if (visited.has(candidate)) {
            return;
        }
        visited.add(candidate);
        const wrapped = "channel" in candidate ? candidate.channel : candidate;
        const channel = asChannelRecord(wrapped);
        if (channel) {
            if (!seen.has(channel.id)) {
                seen.add(channel.id);
                collected.push(channel);
            }
            return;
        }
        for (const nested of Object.values(candidate)) {
            visit(nested);
        }
    };
    visit(value);
    return collected;
}

function parseMessageCreateEvent(value: unknown): MessageCreateEvent | undefined {
    if (!isRecord(value) || !isRecord(value.message)) {
        return undefined;
    }
    const message = value.message;
    if (
        !isNonEmptyString(message.id) ||
        !isNonEmptyString(message.channel_id) ||
        !isRecord(message.author) ||
        !isNonEmptyString(message.author.id)
    ) {
        return undefined;
    }
    return {
        message: {
            id: message.id,
            channel_id: message.channel_id,
            author: { id: message.author.id },
        },
    };
}

function channelPredicate(
    channel: ChannelRecord,
    method: "isDM" | "isGroupDM" | "isThread",
): boolean | undefined {
    const predicate = channel[method];
    if (typeof predicate === "function") {
        const result = safeCall(() => Reflect.apply(predicate, channel, []));
        if (typeof result === "boolean") {
            return result;
        }
    }
    return undefined;
}

function typeMatches(channel: ChannelRecord, ...types: readonly DiscordChannelType[]): boolean {
    return typeof channel.type === "number" && types.includes(channel.type);
}

function channelLabel(channel: ChannelRecord): string {
    return isNonEmptyString(channel.name) ? channel.name : channel.id;
}

function userDisplayName(user: Record<string, unknown>): string | undefined {
    for (const candidate of [user.globalName, user.displayName, user.username]) {
        if (isNonEmptyString(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function recordImageUrl(record: Record<string, unknown>, method: string): string | undefined {
    const getUrl = record[method];
    if (typeof getUrl !== "function") {
        return undefined;
    }
    const imageUrl = safeCall(() => Reflect.apply(getUrl, record, []));
    return isNonEmptyString(imageUrl) ? imageUrl : undefined;
}

function guildImageUrl(guild: GuildRecord): string | undefined {
    const resolved = recordImageUrl(guild, "getIconURL");
    if (resolved) {
        return resolved;
    }
    if (!isSnowflake(guild.id) || !isDiscordAssetHash(guild.icon)) {
        return undefined;
    }
    const animated = guild.icon.startsWith("a_");
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64${animated ? "&animated=true" : ""}`;
}

function channelPosition(channel: ChannelRecord, fallback: number): number {
    return isNonNegativeInteger(channel.position) ? channel.position : fallback;
}

function asDispatcher(value: unknown): Dispatcher | undefined {
    if (!hasFunctions(value, ["subscribe", "unsubscribe", "dispatch"])) {
        return undefined;
    }
    return {
        subscribe: (type, listener) => {
            callBound(value, "subscribe", [type, listener]);
        },
        unsubscribe: (type, listener) => {
            callBound(value, "unsubscribe", [type, listener]);
        },
        dispatch: (event) => {
            callBound(value, "dispatch", [event]);
        },
    };
}

function asChannelStore(value: unknown): ChannelStore | undefined {
    if (!hasFunctions(value, ["getChannel"])) {
        return undefined;
    }
    return { getChannel: (channelId) => callBound(value, "getChannel", [channelId]) };
}

function asGuildStore(value: unknown): GuildStore | undefined {
    if (!hasFunctions(value, ["getGuilds"])) {
        return undefined;
    }
    return { getGuilds: () => callBound(value, "getGuilds", []) };
}

function asGuildChannelStore(value: unknown): GuildChannelStore | undefined {
    if (!hasFunctions(value, ["getChannels"])) {
        return undefined;
    }
    return { getChannels: (guildId) => callBound(value, "getChannels", [guildId]) };
}

function asPrivateChannelSortStore(value: unknown): PrivateChannelSortStore | undefined {
    if (!hasFunctions(value, ["getPrivateChannelIds"])) {
        return undefined;
    }
    return {
        getPrivateChannelIds: () => callBound(value, "getPrivateChannelIds", []),
    };
}

function asReadStateStore(value: unknown): ReadStateStore | undefined {
    if (!hasFunctions(value, ["hasUnread", "getMentionCount", "lastMessageId"])) {
        return undefined;
    }
    return {
        hasUnread: (channelId) => callBound(value, "hasUnread", [channelId]),
        getMentionCount: (channelId) => callBound(value, "getMentionCount", [channelId]),
        lastMessageId: (channelId) => callBound(value, "lastMessageId", [channelId]),
    };
}

function asUserStore(value: unknown): UserStore | undefined {
    if (!hasFunctions(value, ["getCurrentUser"])) {
        return undefined;
    }
    return {
        getCurrentUser: () => callBound(value, "getCurrentUser", []),
        ...(typeof value.getUser === "function"
            ? { getUser: (userId: string) => callBound(value, "getUser", [userId]) }
            : {}),
    };
}

function asChannelRecord(value: unknown, expectedId?: string): ChannelRecord | undefined {
    if (
        !isRecord(value) ||
        !isNonEmptyString(value.id) ||
        (expectedId && value.id !== expectedId)
    ) {
        return undefined;
    }
    if ("type" in value && !(typeof value.type === "number" && Number.isInteger(value.type))) {
        return undefined;
    }
    return value as ChannelRecord;
}

function hasFunctions(
    value: unknown,
    keys: readonly string[],
): value is Record<string, (...args: never[]) => unknown> {
    return isRecord(value) && keys.every((key) => typeof value[key] === "function");
}

function callBound(
    receiver: Record<string, (...args: never[]) => unknown>,
    method: string,
    args: readonly unknown[],
): unknown {
    const operation = receiver[method];
    if (!operation) {
        throw new TypeError(`Missing validated method: ${method}`);
    }
    return Reflect.apply(operation, receiver, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
}

function isDiscordAssetHash(value: unknown): value is string {
    return typeof value === "string" && /^(?:a_)?[a-f\d]{32}$/i.test(value);
}

function safeCall<T>(operation: () => T): T | undefined {
    try {
        return operation();
    } catch {
        return undefined;
    }
}

function reportAdapterEventError(reporter: AdapterEventErrorReporter, error: unknown): void {
    try {
        reporter(ADAPTER_EVENT_ERROR_CODE, error);
    } catch {
        // Adapter error reporting must not interrupt the Flux callback.
    }
}

function ignoreAdapterEventError(): void {}
