import type { DiscordAdapter } from "../discord/adapter";
import type { ScopeRef } from "../policy/model";
import { ruleKey, type MentionPolicy, type ReadDecision } from "../settings/model";
import type { SettingsStore } from "../settings/store";

const MENU_ID = "smart-auto-read";
const CATEGORY_CHANNEL_TYPE = 4;

type ContextMenuApi = Pick<BetterDiscord.BdApi, "ContextMenu"> &
    Partial<Pick<BetterDiscord.BdApi, "Logger">>;
type ContextMenuPatchCallback = Parameters<BetterDiscord.ContextMenu["patch"]>[1];
type ContextMenuRenderInstance = Parameters<ContextMenuPatchCallback>[2];
type ContextMenuActionEvent = Parameters<NonNullable<BetterDiscord.MenuItemRadio["action"]>>[0];
type ContextMenuAdapter = Pick<DiscordAdapter, "findPrivateChannelIdForUser" | "getChannelContext">;

interface MenuProps extends Record<string, unknown> {
    guild?: unknown;
    channel?: unknown;
    channelId?: unknown;
    message?: unknown;
    member?: unknown;
    user?: unknown;
}

interface ChannelRecord extends Record<string, unknown> {
    id: string;
}

type MenuTarget = { kind: "scope"; scope: ScopeRef } | { kind: "unavailable-member" };

export class ContextMenuController {
    private unpatches: Array<() => void> = [];

    constructor(
        private readonly api: ContextMenuApi,
        private readonly adapter: ContextMenuAdapter,
        private readonly settings: SettingsStore,
    ) {}

    start(): void {
        if (this.unpatches.length > 0) {
            return;
        }
        const unpatch = this.api.ContextMenu.patch("*", (tree, props, instance) => {
            try {
                const target = resolveMenuTarget(this.adapter, props);
                if (target) {
                    this.appendNativeScopeItem(tree, target, instance);
                }
            } catch {
                // Unexpected Discord props must never break the host context menu.
            }
        });
        this.unpatches = [unpatch];
    }

    stop(): void {
        const unpatches = this.unpatches;
        this.unpatches = [];
        this.cleanup(unpatches);
    }

    private cleanup(unpatches: readonly (() => void)[]): void {
        const failed: Array<() => void> = [];
        const errors: unknown[] = [];
        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch (error) {
                failed.push(unpatch);
                errors.push(error);
                this.logCleanupError(error);
            }
        }
        this.unpatches.push(...failed);
        if (errors.length > 0) {
            throw new AggregateError(
                errors,
                "One or more context-menu patches could not be removed.",
            );
        }
    }

    private logCleanupError(error: unknown): void {
        try {
            this.api.Logger?.error(error);
        } catch {
            // Cleanup logging must not interrupt remaining cleanup.
        }
    }

    private appendNativeScopeItem(
        tree: unknown,
        target: MenuTarget,
        instance?: ContextMenuRenderInstance,
    ): void {
        const children = menuChildren(tree);
        if (!children || hasSmartAutoReadMenu(children)) {
            return;
        }
        children.push(
            this.api.ContextMenu.buildItem(
                this.buildSubmenu(target, () => this.requestMenuRerender(instance)),
            ),
        );
    }

    private buildSubmenu(target: MenuTarget, refresh: () => void): BetterDiscord.MenuItemSubmenu {
        if (target.kind === "unavailable-member") {
            return {
                type: "submenu",
                id: MENU_ID,
                label: "Smart Auto Read",
                items: [textItem("member-unavailable", "Open a DM with this member first.")],
            };
        }

        const scope = target.scope;
        const current = this.settings.snapshot.rules[ruleKey(scope.scopeType, scope.scopeId)];
        const decision = current?.decision ?? "inherit";
        const mentionPolicy = current?.mentionPolicy ?? "inherit";
        return {
            type: "submenu",
            id: MENU_ID,
            label: "Smart Auto Read",
            items: [
                textItem(
                    "read-heading",
                    "Read behavior",
                    "Controls whether this scope is marked as read.",
                ),
                ...readDecisionItems(decision, (event, value) => {
                    event.preventDefault();
                    this.updateRule(scope, value, undefined);
                    refresh();
                }),
                { type: "separator" },
                textItem(
                    "mention-heading",
                    "Mention safety",
                    "Protect keeps mentions unread for this scope.",
                ),
                ...mentionPolicyItems(mentionPolicy, (event, value) => {
                    event.preventDefault();
                    this.updateRule(scope, undefined, value);
                    refresh();
                }),
            ],
        };
    }

    private updateRule(
        scope: ScopeRef,
        decision: ReadDecision | undefined,
        mentionPolicy: MentionPolicy | undefined,
    ): void {
        const current = this.settings.snapshot.rules[ruleKey(scope.scopeType, scope.scopeId)];
        const nextDecision = decision ?? current?.decision ?? "inherit";
        const nextMentionPolicy = mentionPolicy ?? current?.mentionPolicy ?? "inherit";
        if (nextDecision === "inherit" && nextMentionPolicy === "inherit") {
            this.settings.removeRule(scope.scopeType, scope.scopeId);
            return;
        }
        this.settings.setRule({
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            decision: nextDecision,
            mentionPolicy: nextMentionPolicy,
        });
    }

    private requestMenuRerender(instance?: ContextMenuRenderInstance): void {
        if (!instance) {
            return;
        }
        try {
            instance.forceUpdate();
        } catch (error) {
            this.logCleanupError(error);
        }
    }
}

function resolveMenuTarget(adapter: ContextMenuAdapter, value: unknown): MenuTarget | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const props = value as MenuProps;
    const messageChannelId = extractMessageChannelId(props);
    if (messageChannelId) {
        return resolveChannelTarget(adapter, messageChannelId);
    }

    const userId = extractUserId(props);
    if (userId) {
        const directChannelId = extractChannelId(props);
        if (directChannelId) {
            const directContext = safeGetChannelContext(adapter, directChannelId);
            if (directContext?.kind === "dm") {
                return { kind: "scope", scope: { scopeType: "dm", scopeId: directChannelId } };
            }
        }
        const privateChannelId = safeFindPrivateChannelIdForUser(adapter, userId);
        if (privateChannelId && safeGetChannelContext(adapter, privateChannelId)?.kind === "dm") {
            return { kind: "scope", scope: { scopeType: "dm", scopeId: privateChannelId } };
        }
        return { kind: "unavailable-member" };
    }

    const channel = asChannelRecord(props.channel);
    const channelId = channel?.id ?? extractChannelId(props);
    if (channel && isCategoryChannel(channel)) {
        return { kind: "scope", scope: { scopeType: "category", scopeId: channel.id } };
    }
    if (channelId) {
        return resolveChannelTarget(adapter, channelId);
    }

    const guildId = extractGuildId(props);
    return guildId ? { kind: "scope", scope: { scopeType: "guild", scopeId: guildId } } : undefined;
}

function extractUserId(props: MenuProps): string | undefined {
    if (isRecord(props.user) && isNonEmptyString(props.user.id)) {
        return props.user.id;
    }
    if (!isRecord(props.member)) {
        return undefined;
    }
    if (isRecord(props.member.user) && isNonEmptyString(props.member.user.id)) {
        return props.member.user.id;
    }
    if (isNonEmptyString(props.member.userId)) {
        return props.member.userId;
    }
    return undefined;
}

function extractChannelId(props: MenuProps): string | undefined {
    const channel = asChannelRecord(props.channel);
    if (channel) {
        return channel.id;
    }
    if (isNonEmptyString(props.channelId)) {
        return props.channelId;
    }
    return undefined;
}

function extractMessageChannelId(props: MenuProps): string | undefined {
    if (!isRecord(props.message)) {
        return undefined;
    }
    if (isNonEmptyString(props.message.channel_id)) {
        return props.message.channel_id;
    }
    return isNonEmptyString(props.message.channelId) ? props.message.channelId : undefined;
}

function resolveChannelTarget(
    adapter: ContextMenuAdapter,
    channelId: string,
): MenuTarget | undefined {
    const context = safeGetChannelContext(adapter, channelId);
    if (context?.kind === "dm" || context?.kind === "group-dm") {
        return { kind: "scope", scope: { scopeType: "dm", scopeId: channelId } };
    }
    if (context?.kind === "guild") {
        return { kind: "scope", scope: { scopeType: "channel", scopeId: channelId } };
    }
    return undefined;
}

function extractGuildId(props: MenuProps): string | undefined {
    return isRecord(props.guild) && isNonEmptyString(props.guild.id) ? props.guild.id : undefined;
}

function asChannelRecord(value: unknown): ChannelRecord | undefined {
    return isRecord(value) && isNonEmptyString(value.id) ? (value as ChannelRecord) : undefined;
}

function isCategoryChannel(channel: ChannelRecord): boolean {
    if (channel.type === CATEGORY_CHANNEL_TYPE) {
        return true;
    }
    const predicate = channel.isCategory;
    if (typeof predicate !== "function") {
        return false;
    }
    try {
        return Reflect.apply(predicate, channel, []) === true;
    } catch {
        return false;
    }
}

function safeGetChannelContext(adapter: ContextMenuAdapter, channelId: string) {
    try {
        return adapter.getChannelContext(channelId);
    } catch {
        return undefined;
    }
}

function safeFindPrivateChannelIdForUser(
    adapter: ContextMenuAdapter,
    userId: string,
): string | undefined {
    try {
        const channelId = adapter.findPrivateChannelIdForUser(userId);
        return isNonEmptyString(channelId) ? channelId : undefined;
    } catch {
        return undefined;
    }
}

function menuChildren(tree: unknown): unknown[] | undefined {
    if (Array.isArray(tree)) {
        return tree;
    }
    if (!isRecord(tree) || !isRecord(tree.props)) {
        return undefined;
    }
    if (Array.isArray(tree.props.children)) {
        return tree.props.children;
    }
    const children = tree.props.children === undefined ? [] : [tree.props.children];
    tree.props.children = children;
    return children;
}

function hasSmartAutoReadMenu(children: readonly unknown[]): boolean {
    return children.some(
        (child) => isRecord(child) && isRecord(child.props) && child.props.id === MENU_ID,
    );
}

function textItem(id: string, label: string, subtext?: string): BetterDiscord.MenuItemDefault {
    return {
        type: "item",
        id: `${MENU_ID}-${id}`,
        label,
        ...(subtext ? { subtext } : {}),
        disabled: true,
    };
}

function readDecisionItems(
    selected: ReadDecision,
    onSelect: (event: ContextMenuActionEvent, value: ReadDecision) => void,
): readonly BetterDiscord.MenuItemRadio[] {
    return [
        radioItem(
            "decision-inherit",
            "Inherit",
            `${MENU_ID}-decision`,
            selected === "inherit",
            (event) => onSelect(event, "inherit"),
        ),
        radioItem(
            "decision-auto-read",
            "Always auto-read",
            `${MENU_ID}-decision`,
            selected === "auto-read",
            (event) => onSelect(event, "auto-read"),
        ),
        radioItem(
            "decision-keep-unread",
            "Keep unread",
            `${MENU_ID}-decision`,
            selected === "keep-unread",
            (event) => onSelect(event, "keep-unread"),
        ),
    ];
}

function mentionPolicyItems(
    selected: MentionPolicy,
    onSelect: (event: ContextMenuActionEvent, value: MentionPolicy) => void,
): readonly BetterDiscord.MenuItemRadio[] {
    return [
        radioItem(
            "mention-inherit",
            "Inherit",
            `${MENU_ID}-mention`,
            selected === "inherit",
            (event) => onSelect(event, "inherit"),
        ),
        radioItem(
            "mention-protect",
            "Protect",
            `${MENU_ID}-mention`,
            selected === "protect",
            (event) => onSelect(event, "protect"),
        ),
        radioItem("mention-allow", "Allow", `${MENU_ID}-mention`, selected === "allow", (event) =>
            onSelect(event, "allow"),
        ),
    ];
}

function radioItem(
    id: string,
    label: string,
    group: string,
    checked: boolean,
    action: (event: ContextMenuActionEvent) => void,
): BetterDiscord.MenuItemRadio {
    return { type: "radio", id: `${MENU_ID}-${id}`, label, group, checked, action };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
