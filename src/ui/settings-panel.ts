import type { ScopeCatalogNode } from "../discord/adapter";
import type { ScopeRef } from "../policy/model";
import type { ReconciliationPreview } from "../reconciliation/reconciler";
import {
    DEFAULT_SETTINGS,
    parseImportedSettings,
    ruleKey,
    type MentionPolicy,
    type ReadDecision,
} from "../settings/model";
import type { SettingsStore } from "../settings/store";
import { buildScopeTree, filterScopeTree, type ScopeTreeNode } from "./scope-tree";

export interface SettingsPanelDependencies {
    api: BetterDiscord.BdApi;
    settings: SettingsStore;
    getRuntimeVersion(): number;
    subscribeRuntime(listener: () => void): () => void;
    getCatalog(): readonly ScopeCatalogNode[];
    getDiagnosticsJson(): string;
    preview(): ReconciliationPreview;
    apply(preview: ReconciliationPreview): Promise<void>;
}

interface ErrorBoundaryProps {
    children?: import("react").ReactNode;
}

interface ErrorBoundaryState {
    failed: boolean;
}

interface PanelState {
    activeTab: "dms" | "servers";
    search: string;
    importJson: string;
    debounceDraft: string;
    debounceEditing: boolean;
    debounceRevision: number;
    modeRevision: number;
    preview?: ReconciliationPreview;
}

const ERROR_FALLBACK =
    "Smart Auto Read settings could not be displayed. Check Diagnostics and the console for details.";
const SPACING_4 = "4px";
const SPACING_8 = "8px";
const SPACING_12 = "12px";

function debounceDraftValue(debounceMs: number): string {
    return String(debounceMs === 0 ? DEFAULT_SETTINGS.debounceMs : debounceMs);
}

export function createSettingsPanel(
    dependencies: SettingsPanelDependencies,
): import("react").ReactElement {
    const React = dependencies.api.React;
    const h = React.createElement;
    const {
        Button,
        DropdownInput,
        Flex,
        NumberInput,
        RadioInput,
        SearchInput,
        SettingGroup,
        SettingItem,
        SwitchInput,
        Text,
        TextInput,
    } = dependencies.api.Components;

    class SettingsErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
        state: ErrorBoundaryState = { failed: false };

        static getDerivedStateFromError(): ErrorBoundaryState {
            return { failed: true };
        }

        componentDidCatch(error: unknown): void {
            this.setState({ failed: true });
            dependencies.api.Logger.error(error);
        }

        render(): import("react").ReactNode {
            if (this.state.failed) {
                return h(Text, { role: "alert", color: Text.Colors.ERROR }, ERROR_FALLBACK);
            }
            return this.props.children;
        }
    }

    class SettingsPanel extends React.Component<Record<string, never>, PanelState> {
        state: PanelState = {
            activeTab: "dms",
            search: "",
            importJson: "",
            debounceDraft: debounceDraftValue(dependencies.settings.snapshot.debounceMs),
            debounceEditing: false,
            debounceRevision: 0,
            modeRevision: 0,
        };

        private unsubscribeSettings: (() => void) | undefined;
        private unsubscribeRuntime: (() => void) | undefined;
        private committingDebounce = false;
        private runtimeVersion = dependencies.getRuntimeVersion();

        componentDidMount(): void {
            this.unsubscribeSettings = dependencies.settings.subscribe(() => {
                const debounceDraft = debounceDraftValue(dependencies.settings.snapshot.debounceMs);
                if (this.committingDebounce || this.state.debounceDraft === debounceDraft) {
                    this.forceUpdate();
                    return;
                }
                this.setState((state) => ({
                    debounceDraft,
                    debounceEditing: false,
                    debounceRevision: state.debounceRevision + 1,
                }));
            });
            this.unsubscribeRuntime = dependencies.subscribeRuntime(() => {
                const runtimeVersion = dependencies.getRuntimeVersion();
                if (runtimeVersion === this.runtimeVersion) {
                    return;
                }
                this.runtimeVersion = runtimeVersion;
                this.forceUpdate();
            });
        }

        componentWillUnmount(): void {
            this.unsubscribeSettings?.();
            this.unsubscribeSettings = undefined;
            this.unsubscribeRuntime?.();
            this.unsubscribeRuntime = undefined;
        }

        render(): import("react").ReactElement {
            const settings = dependencies.settings.snapshot;
            const tree = buildScopeTree(dependencies.getCatalog(), settings);

            return h(
                React.Fragment,
                null,
                this.renderGeneral(),
                this.renderScopes(tree),
                this.renderRules(tree),
                this.renderReconciliation(),
                this.renderConfiguration(),
                this.renderDiagnostics(),
            );
        }

        private renderSpacer(basis: string, key: string): import("react").ReactElement {
            return h(Flex.Child, {
                key,
                "aria-hidden": true,
                basis,
                grow: 0,
                shrink: 0,
            });
        }

        private renderButtonRow(
            label: string,
            buttons: readonly import("react").ReactElement[],
        ): import("react").ReactElement {
            const children = buttons.flatMap((button, index) =>
                index === 0
                    ? [button]
                    : [this.renderSpacer(SPACING_8, `${label}-space-${index}`), button],
            );
            return h(
                "div",
                {
                    role: "group",
                    "aria-label": label,
                },
                h(Flex, { align: Flex.Align.CENTER, wrap: Flex.Wrap.WRAP }, children),
            );
        }

        private renderGeneral(): import("react").ReactElement {
            const settings = dependencies.settings.snapshot;
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-general",
                    name: "General",
                    settings: [],
                    collapsible: true,
                    shown: true,
                },
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-mode",
                        name: "Default mode",
                        note: "Include reads only matching rules. Exclude reads everything supported unless an override keeps it unread.",
                        inline: false,
                    },
                    h(
                        "div",
                        { role: "radiogroup", "aria-label": "Default mode" },
                        h(RadioInput, {
                            key: `mode-${settings.mode}-${this.state.modeRevision}`,
                            name: "smart-auto-read-mode",
                            value: settings.mode,
                            options: [
                                {
                                    name: "Include",
                                    value: "include",
                                    description: "Auto-read only scopes allowed by a rule.",
                                },
                                {
                                    name: "Exclude",
                                    value: "exclude",
                                    description:
                                        "Auto-read supported scopes unless a rule keeps them unread.",
                                },
                            ],
                            onChange: (value: unknown) => this.updateMode(value),
                        }),
                    ),
                ),
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-debounce-enabled",
                        name: "Enable debounce",
                        note: "Wait briefly and coalesce matching messages before marking them as read.",
                        inline: true,
                    },
                    h(
                        "div",
                        { role: "group", "aria-label": "Enable debounce" },
                        h(SwitchInput, {
                            id: "smart-auto-read-debounce-enabled",
                            value: settings.debounceMs !== 0,
                            onChange: (value?: boolean) => {
                                if (typeof value === "boolean") {
                                    this.updateDebounceEnabled(value);
                                }
                            },
                        }),
                    ),
                ),
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-debounce",
                        name: "Debounce delay",
                        note: "Wait before acknowledging a matching conversation, in milliseconds.",
                        inline: true,
                    },
                    h(
                        "div",
                        {
                            role: "group",
                            "aria-label": "Debounce delay in milliseconds",
                            onFocus: () => this.setState({ debounceEditing: true }),
                            onBlur: (event: import("react").FocusEvent<HTMLDivElement>) =>
                                this.handleDebounceBlur(event),
                            onKeyDown: (event: import("react").KeyboardEvent<HTMLDivElement>) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    this.commitDebounceDraft();
                                }
                            },
                        },
                        h(NumberInput, {
                            key: `debounce-${this.state.debounceRevision}`,
                            value: Number(this.state.debounceDraft) || DEFAULT_SETTINGS.debounceMs,
                            disabled: settings.debounceMs === 0,
                            min: 250,
                            max: 30_000,
                            step: 50,
                            onChange: (value: number) => this.updateDebounceDraft(value),
                        }),
                    ),
                ),
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-reconcile-on-start",
                        name: "Process existing unread messages on start",
                        note: "Preview rules are applied when the plugin starts, not only to new messages.",
                        inline: true,
                    },
                    h(
                        "div",
                        {
                            role: "group",
                            "aria-label": "Process existing unread messages on start",
                        },
                        h(SwitchInput, {
                            id: "smart-auto-read-reconcile-on-start",
                            value: settings.reconcileOnStart,
                            onChange: (value?: boolean) => {
                                if (typeof value === "boolean") {
                                    dependencies.settings.patch({ reconcileOnStart: value });
                                }
                            },
                        }),
                    ),
                ),
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-mention-policy",
                        name: "Global mention policy",
                        note: "Protect keeps conversations with unread mentions unread unless a narrower rule allows them.",
                        inline: true,
                    },
                    h(
                        "div",
                        { role: "group", "aria-label": "Global mention policy" },
                        h(DropdownInput, {
                            key: `global-mentions-${settings.globalMentionPolicy}`,
                            value: settings.globalMentionPolicy,
                            options: [
                                { value: "protect", label: "Protect mentions" },
                                { value: "allow", label: "Allow auto-read" },
                            ],
                            onChange: (value: unknown) => {
                                const selected = controlValue(value);
                                if (selected === "protect" || selected === "allow") {
                                    dependencies.settings.patch({ globalMentionPolicy: selected });
                                }
                            },
                        }),
                    ),
                ),
            );
        }

        private renderScopes(tree: readonly ScopeTreeNode[]): import("react").ReactElement {
            const tabTree = tree.filter((node) =>
                this.state.activeTab === "dms" ? isDmNode(node) : !isDmNode(node),
            );
            const filtered = filterScopeTree(tabTree, this.state.search);
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-scopes",
                    name: "Scopes",
                    settings: [],
                    collapsible: true,
                    shown: true,
                },
                h(
                    Flex,
                    {
                        direction: Flex.Direction.VERTICAL,
                    },
                    h(
                        Flex,
                        {
                            align: Flex.Align.CENTER,
                            wrap: Flex.Wrap.WRAP,
                        },
                        this.renderTab("dms", "DMs"),
                        this.renderSpacer(SPACING_8, "scope-type-space"),
                        this.renderTab("servers", "Servers"),
                    ),
                    this.renderSpacer(SPACING_8, "scope-browser-tabs-space"),
                    h(
                        "div",
                        {
                            role: "search",
                            "aria-label": "Search scopes",
                        },
                        h(SearchInput, {
                            defaultValue: "",
                            placeholder: "Search DMs, servers, categories, channels, or threads",
                            onChange: (value: unknown) =>
                                this.setState({ search: String(controlValue(value) ?? "") }),
                        }),
                    ),
                    this.renderSpacer(SPACING_8, "scope-browser-search-space"),
                    h(
                        "div",
                        {
                            role: "region",
                            "aria-label":
                                this.state.activeTab === "dms" ? "DM scopes" : "Server scopes",
                        },
                        filtered.length > 0
                            ? filtered.map((node) => this.renderScopeNode(node, 0))
                            : h(Text, { color: Text.Colors.MUTED }, "No matching scopes."),
                    ),
                ),
            );
        }

        private renderTab(
            tab: PanelState["activeTab"],
            label: string,
        ): import("react").ReactElement {
            const selected = this.state.activeTab === tab;
            return h(
                Button,
                {
                    type: "button",
                    look: selected ? Button.Looks.FILLED : Button.Looks.OUTLINED,
                    color: selected ? Button.Colors.BRAND : Button.Colors.PRIMARY,
                    size: Button.Sizes.SMALL,
                    onClick: () => this.setState({ activeTab: tab }),
                },
                label,
            );
        }

        private renderScopeNode(node: ScopeTreeNode, depth: number): import("react").ReactElement {
            const rule =
                dependencies.settings.snapshot.rules[
                    ruleKey(node.scope.scopeType, node.scope.scopeId)
                ];
            return h(
                React.Fragment,
                {
                    key: ruleKey(node.scope.scopeType, node.scope.scopeId),
                },
                h(
                    SettingItem,
                    {
                        id: `smart-auto-read-scope-${ruleKey(node.scope.scopeType, node.scope.scopeId)}`,
                        name: `${"› ".repeat(depth)}${node.label}`,
                        note: `Effective: ${decisionLabel(node.effectiveDecision)}, mentions ${mentionLabel(node.effectiveMentionPolicy)}`,
                        inline: false,
                    },
                    h(
                        React.Fragment,
                        null,
                        this.renderScopeIdentity(node),
                        this.renderSpacer(
                            SPACING_8,
                            `scope-identity-space-${ruleKey(node.scope.scopeType, node.scope.scopeId)}`,
                        ),
                        this.renderRuleControls(node.scope, node.label, rule),
                    ),
                ),
                node.children.length > 0
                    ? node.children.map((child) => this.renderScopeNode(child, depth + 1))
                    : null,
            );
        }

        private renderRuleControls(
            scope: ScopeRef,
            label: string,
            rule:
                | {
                      readonly decision: ReadDecision;
                      readonly mentionPolicy: MentionPolicy;
                  }
                | undefined,
        ): import("react").ReactElement {
            return h(
                Flex,
                {
                    align: Flex.Align.STRETCH,
                    wrap: Flex.Wrap.WRAP,
                },
                h(
                    Flex.Child,
                    {
                        basis: "240px",
                        role: "group",
                        "aria-label": `Read decision for ${label}`,
                        direction: Flex.Direction.VERTICAL,
                    },
                    h(
                        Text,
                        {
                            color: Text.Colors.HEADER_SECONDARY,
                            size: Text.Sizes.SIZE_12,
                            strong: true,
                        },
                        "Read decision",
                    ),
                    this.renderSpacer(
                        SPACING_4,
                        `read-label-space-${ruleKey(scope.scopeType, scope.scopeId)}`,
                    ),
                    h(DropdownInput, {
                        key: `read-${rule?.decision ?? "inherit"}`,
                        value: rule?.decision ?? "inherit",
                        options: [
                            { value: "inherit", label: "Inherit" },
                            { value: "auto-read", label: "Always auto-read" },
                            { value: "keep-unread", label: "Keep unread" },
                        ],
                        onChange: (value: unknown) =>
                            this.updateDecision(scope, String(controlValue(value) ?? "")),
                    }),
                ),
                this.renderSpacer(
                    SPACING_12,
                    `rule-column-space-${ruleKey(scope.scopeType, scope.scopeId)}`,
                ),
                h(
                    Flex.Child,
                    {
                        basis: "240px",
                        role: "group",
                        "aria-label": `Mention policy for ${label}`,
                        direction: Flex.Direction.VERTICAL,
                    },
                    h(
                        Text,
                        {
                            color: Text.Colors.HEADER_SECONDARY,
                            size: Text.Sizes.SIZE_12,
                            strong: true,
                        },
                        "Mention policy",
                    ),
                    this.renderSpacer(
                        SPACING_4,
                        `mention-label-space-${ruleKey(scope.scopeType, scope.scopeId)}`,
                    ),
                    h(DropdownInput, {
                        key: `mentions-${rule?.mentionPolicy ?? "inherit"}`,
                        value: rule?.mentionPolicy ?? "inherit",
                        options: [
                            { value: "inherit", label: "Inherit" },
                            { value: "protect", label: "Protect" },
                            { value: "allow", label: "Allow" },
                        ],
                        onChange: (value: unknown) =>
                            this.updateMentionPolicy(scope, String(controlValue(value) ?? "")),
                    }),
                ),
            );
        }

        private renderScopeIdentity(node: ScopeTreeNode): import("react").ReactElement {
            const kind = scopePresentationKind(node);
            return h(
                Flex,
                { align: Flex.Align.CENTER },
                h(
                    Flex,
                    {
                        basis: "auto",
                        grow: 0,
                        shrink: 0,
                        align: Flex.Align.CENTER,
                        justify: Flex.Justify.CENTER,
                        style: { width: "44px" },
                    },
                    node.imageUrl
                        ? h("img", {
                              src: node.imageUrl,
                              alt: "",
                              width: 36,
                              height: 36,
                              loading: "lazy",
                              referrerPolicy: "no-referrer",
                          })
                        : h(
                              Text,
                              {
                                  "aria-hidden": true,
                                  color: Text.Colors.HEADER_PRIMARY,
                                  size: Text.Sizes.SIZE_20,
                                  strong: true,
                              },
                              scopeFallback(node, kind),
                          ),
                ),
                h(
                    Flex,
                    { direction: Flex.Direction.VERTICAL },
                    h(
                        Text,
                        { color: Text.Colors.HEADER_PRIMARY, strong: true },
                        scopeKindLabel(kind),
                    ),
                    h(
                        Text,
                        {
                            color: Text.Colors.MUTED,
                            size: Text.Sizes.SIZE_12,
                            selectable: true,
                            title: node.scope.scopeId,
                        },
                        node.scope.scopeId,
                    ),
                ),
            );
        }

        private renderRules(tree: readonly ScopeTreeNode[]): import("react").ReactElement {
            const nodesByKey = collectNodesByKey(tree);
            const rules = Object.values(dependencies.settings.snapshot.rules).sort((left, right) =>
                ruleKey(left.scopeType, left.scopeId).localeCompare(
                    ruleKey(right.scopeType, right.scopeId),
                ),
            );
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-rules",
                    name: "Active overrides",
                    settings: [],
                    collapsible: true,
                    shown: false,
                },
                h(
                    Flex,
                    {
                        direction: Flex.Direction.VERTICAL,
                    },
                    h(
                        Text,
                        { color: Text.Colors.MUTED },
                        "Stored rules take precedence over broader scopes. Set both choices to Inherit to remove one.",
                    ),
                    this.renderSpacer(SPACING_8, "active-overrides-description-space"),
                    rules.length > 0
                        ? rules.map((rule) => {
                              const key = ruleKey(rule.scopeType, rule.scopeId);
                              const node = nodesByKey.get(key);
                              if (!node) {
                                  return null;
                              }
                              return h(
                                  SettingItem,
                                  {
                                      key,
                                      id: `smart-auto-read-active-${key}`,
                                      name: node.label,
                                      note: node.resolved
                                          ? "Available in Discord. Changes here update the same stored rule."
                                          : "Unavailable in Discord. Set both choices to Inherit to remove this stored rule.",
                                      inline: false,
                                  },
                                  h(
                                      React.Fragment,
                                      null,
                                      this.renderScopeIdentity(node),
                                      this.renderSpacer(SPACING_8, `active-identity-space-${key}`),
                                      this.renderRuleControls(node.scope, node.label, rule),
                                  ),
                              );
                          })
                        : h(Text, { color: Text.Colors.MUTED }, "No stored overrides."),
                ),
            );
        }

        private renderReconciliation(): import("react").ReactElement {
            const count = this.state.preview?.matched.length;
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-existing",
                    name: "Existing unread messages",
                    settings: [],
                    collapsible: true,
                    shown: true,
                },
                h(
                    Flex,
                    {
                        direction: Flex.Direction.VERTICAL,
                    },
                    count === undefined
                        ? h(Text, { color: Text.Colors.MUTED }, "Preview before applying changes.")
                        : h(
                              Text,
                              null,
                              `${count} matching unread ${count === 1 ? "conversation" : "conversations"}`,
                          ),
                    this.renderSpacer(SPACING_8, "existing-unread-description-space"),
                    this.renderButtonRow("Existing unread actions", [
                        h(
                            Button,
                            {
                                key: "preview",
                                type: "button",
                                color: Button.Colors.PRIMARY,
                                onClick: () => this.setState({ preview: dependencies.preview() }),
                            },
                            "Preview matches",
                        ),
                        h(
                            Button,
                            {
                                key: "apply",
                                type: "button",
                                color: Button.Colors.BRAND,
                                disabled: this.state.preview === undefined,
                                onClick: () => this.confirmApply(),
                            },
                            "Apply now",
                        ),
                    ]),
                ),
            );
        }

        private renderConfiguration(): import("react").ReactElement {
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-configuration",
                    name: "Configuration",
                    settings: [],
                    collapsible: true,
                    shown: false,
                },
                h(
                    SettingItem,
                    {
                        id: "smart-auto-read-import-json",
                        name: "Settings JSON",
                        note: "Paste a previously exported Smart Auto Read settings document.",
                        inline: false,
                    },
                    h(
                        Flex,
                        {
                            direction: Flex.Direction.VERTICAL,
                        },
                        h(TextInput, {
                            value: this.state.importJson,
                            placeholder: "Paste exported settings JSON",
                            onChange: (value: string) => this.setState({ importJson: value }),
                        }),
                    ),
                ),
                this.renderButtonRow("Configuration actions", [
                    h(
                        Button,
                        {
                            key: "import",
                            type: "button",
                            color: Button.Colors.PRIMARY,
                            onClick: () => this.confirmImport(),
                        },
                        "Import settings",
                    ),
                    h(
                        Button,
                        {
                            key: "export",
                            type: "button",
                            color: Button.Colors.PRIMARY,
                            onClick: () =>
                                void this.copyText("Settings", dependencies.settings.exportJson()),
                        },
                        "Export settings",
                    ),
                    h(
                        Button,
                        {
                            key: "reset",
                            type: "button",
                            color: Button.Colors.RED,
                            onClick: () => this.confirmReset(),
                        },
                        "Reset settings",
                    ),
                ]),
            );
        }

        private renderDiagnostics(): import("react").ReactElement {
            return h(
                SettingGroup,
                {
                    id: "smart-auto-read-diagnostics",
                    name: "Diagnostics",
                    settings: [],
                    collapsible: true,
                    shown: false,
                },
                h(
                    Flex,
                    {
                        direction: Flex.Direction.VERTICAL,
                    },
                    h(
                        Text,
                        { color: Text.Colors.MUTED },
                        "Diagnostics exclude account, server, channel, and message content.",
                    ),
                    this.renderSpacer(SPACING_8, "diagnostics-description-space"),
                    h(
                        Button,
                        {
                            type: "button",
                            color: Button.Colors.PRIMARY,
                            onClick: () =>
                                void this.copyText(
                                    "Diagnostics",
                                    dependencies.getDiagnosticsJson(),
                                ),
                        },
                        "Copy diagnostics",
                    ),
                ),
            );
        }

        private confirmExcludeMode(): void {
            if (dependencies.settings.snapshot.mode === "exclude") {
                return;
            }
            dependencies.api.UI.showConfirmationModal(
                "Enable Exclude mode?",
                "Exclude mode automatically reads supported conversations unless a rule keeps them unread.",
                {
                    confirmText: "Enable Exclude",
                    cancelText: "Cancel",
                    danger: true,
                    onConfirm: () => dependencies.settings.patch({ mode: "exclude" }),
                },
            );
        }

        private updateMode(value: unknown): void {
            const selected = controlValue(value);
            if (selected === "include") {
                dependencies.settings.patch({ mode: "include" });
                return;
            }
            if (selected === "exclude") {
                this.setState((state) => ({ modeRevision: state.modeRevision + 1 }));
                this.confirmExcludeMode();
            }
        }

        private updateDebounceDraft(value: string | number): void {
            const selected = controlValue(value);
            const debounceDraft =
                typeof selected === "number" && Number.isNaN(selected)
                    ? ""
                    : String(selected ?? "");
            this.setState({ debounceDraft, debounceEditing: true });
        }

        private updateDebounceEnabled(enabled: boolean): void {
            if (!enabled) {
                dependencies.settings.patch({ debounceMs: 0 });
                return;
            }
            const draft = Number(this.state.debounceDraft);
            dependencies.settings.patch({
                debounceMs:
                    Number.isFinite(draft) && draft >= 250 && draft <= 30_000
                        ? draft
                        : DEFAULT_SETTINGS.debounceMs,
            });
        }

        private handleDebounceBlur(event: import("react").FocusEvent<HTMLDivElement>): void {
            const next = event.relatedTarget;
            if (next && event.currentTarget.contains(next as Node)) {
                return;
            }
            this.commitDebounceDraft();
        }

        private commitDebounceDraft(): void {
            if (!this.state.debounceEditing) {
                return;
            }
            if (dependencies.settings.snapshot.debounceMs === 0) {
                this.setState({
                    debounceDraft: debounceDraftValue(0),
                    debounceEditing: false,
                });
                return;
            }
            const draft = this.state.debounceDraft.trim();
            const debounceMs = draft.length > 0 ? Number(draft) : Number.NaN;
            if (!Number.isFinite(debounceMs) || debounceMs < 250 || debounceMs > 30_000) {
                this.setState((state) => ({
                    debounceDraft: String(dependencies.settings.snapshot.debounceMs),
                    debounceEditing: false,
                    debounceRevision: state.debounceRevision + 1,
                }));
                return;
            }
            this.committingDebounce = true;
            try {
                dependencies.settings.patch({ debounceMs });
            } finally {
                this.committingDebounce = false;
            }
            this.setState({
                debounceDraft: String(dependencies.settings.snapshot.debounceMs),
                debounceEditing: false,
            });
        }

        private confirmApply(): void {
            const approved = this.state.preview;
            if (!approved) {
                return;
            }
            const count = approved.matched.length;
            dependencies.api.UI.showConfirmationModal(
                "Apply Smart Auto Read now?",
                `This will mark ${count} matching unread ${count === 1 ? "conversation" : "conversations"} as read.`,
                {
                    confirmText: "Apply now",
                    cancelText: "Cancel",
                    danger: true,
                    onConfirm: async () => {
                        try {
                            await dependencies.apply(approved);
                            dependencies.api.UI.showToast(
                                `Applied Smart Auto Read to ${count} ${count === 1 ? "conversation" : "conversations"}.`,
                                { type: "success" },
                            );
                        } catch {
                            dependencies.api.UI.showToast(
                                "Smart Auto Read could not apply the preview.",
                                {
                                    type: "error",
                                },
                            );
                        }
                    },
                },
            );
        }

        private confirmImport(): void {
            const json = this.state.importJson;
            const validation = parseImportedSettings(json);
            if (!validation.ok) {
                dependencies.api.UI.showToast(validation.error, { type: "error" });
                return;
            }
            dependencies.api.UI.showConfirmationModal(
                "Import Smart Auto Read settings?",
                "This replaces the current settings and rules.",
                {
                    confirmText: "Import",
                    cancelText: "Cancel",
                    danger: true,
                    onConfirm: () => {
                        const result = dependencies.settings.importJson(json);
                        dependencies.api.UI.showToast(
                            result.ok ? "Smart Auto Read settings imported." : result.error,
                            { type: result.ok ? "success" : "error" },
                        );
                    },
                },
            );
        }

        private confirmReset(): void {
            dependencies.api.UI.showConfirmationModal(
                "Reset Smart Auto Read settings?",
                "This removes every stored rule and restores safe Include mode defaults.",
                {
                    confirmText: "Reset",
                    cancelText: "Cancel",
                    danger: true,
                    onConfirm: () => {
                        dependencies.settings.replace({ ...DEFAULT_SETTINGS, rules: {} });
                        this.setState({ preview: undefined, importJson: "" });
                        dependencies.api.UI.showToast("Smart Auto Read settings reset.", {
                            type: "success",
                        });
                    },
                },
            );
        }

        private updateDecision(scope: ScopeRef, value: string): void {
            if (value !== "inherit" && value !== "auto-read" && value !== "keep-unread") {
                return;
            }
            this.updateRule(scope, value, undefined);
        }

        private updateMentionPolicy(scope: ScopeRef, value: string): void {
            if (value !== "inherit" && value !== "protect" && value !== "allow") {
                return;
            }
            this.updateRule(scope, undefined, value);
        }

        private updateRule(
            scope: ScopeRef,
            decision: ReadDecision | undefined,
            mentionPolicy: MentionPolicy | undefined,
        ): void {
            const current =
                dependencies.settings.snapshot.rules[ruleKey(scope.scopeType, scope.scopeId)];
            const nextDecision = decision ?? current?.decision ?? "inherit";
            const nextMentionPolicy = mentionPolicy ?? current?.mentionPolicy ?? "inherit";
            if (nextDecision === "inherit" && nextMentionPolicy === "inherit") {
                dependencies.settings.removeRule(scope.scopeType, scope.scopeId);
                return;
            }
            dependencies.settings.setRule({
                ...scope,
                decision: nextDecision,
                mentionPolicy: nextMentionPolicy,
            });
        }

        private async copyText(label: string, content: string): Promise<void> {
            try {
                await navigator.clipboard.writeText(content);
                dependencies.api.UI.showToast(`${label} copied.`, { type: "success" });
            } catch (error) {
                dependencies.api.Logger.error(error);
                dependencies.api.UI.showToast(`${label} could not be copied.`, { type: "error" });
            }
        }
    }

    return h(SettingsErrorBoundary, null, h(SettingsPanel, null)) as import("react").ReactElement;
}

function isDmNode(node: ScopeTreeNode): boolean {
    return node.scope.scopeType === "all-dms" || node.scope.scopeType === "dm";
}

function scopePresentationKind(node: ScopeTreeNode): NonNullable<ScopeTreeNode["kind"]> {
    if (node.kind) {
        return node.kind;
    }
    if (node.scope.scopeType === "all-dms") {
        return "all-dms";
    }
    if (node.scope.scopeType === "dm") {
        return "dm";
    }
    return node.scope.scopeType;
}

function scopeKindLabel(kind: NonNullable<ScopeTreeNode["kind"]>): string {
    const labels: Record<NonNullable<ScopeTreeNode["kind"]>, string> = {
        "all-dms": "DMs",
        dm: "DM",
        "group-dm": "Group DM",
        guild: "Server",
        category: "Category",
        channel: "Channel",
        thread: "Thread",
    };
    return labels[kind];
}

function scopeFallback(node: ScopeTreeNode, kind: NonNullable<ScopeTreeNode["kind"]>): string {
    if (kind === "channel") {
        return "#";
    }
    if (kind === "thread") {
        return "T";
    }
    if (kind === "category") {
        return "C";
    }
    return Array.from(node.label.trim())[0]?.toLocaleUpperCase() || "?";
}

function collectNodesByKey(tree: readonly ScopeTreeNode[]): Map<string, ScopeTreeNode> {
    const nodes = new Map<string, ScopeTreeNode>();
    appendNodesByKey(tree, nodes);
    return nodes;
}

function appendNodesByKey(tree: readonly ScopeTreeNode[], nodes: Map<string, ScopeTreeNode>): void {
    for (const node of tree) {
        nodes.set(ruleKey(node.scope.scopeType, node.scope.scopeId), node);
        appendNodesByKey(node.children, nodes);
    }
}

function controlValue(value: unknown): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    if ("currentTarget" in value) {
        const currentTarget = value.currentTarget;
        if (
            typeof currentTarget === "object" &&
            currentTarget !== null &&
            "value" in currentTarget
        ) {
            return currentTarget.value;
        }
    }
    if ("target" in value) {
        const target = value.target;
        if (typeof target === "object" && target !== null && "value" in target) {
            return target.value;
        }
    }
    return value;
}

function decisionLabel(decision: ReadDecision): string {
    switch (decision) {
        case "inherit":
            return "Inherit";
        case "auto-read":
            return "Always auto-read";
        case "keep-unread":
            return "Keep unread";
    }
}

function mentionLabel(policy: MentionPolicy): string {
    switch (policy) {
        case "inherit":
            return "Inherit";
        case "protect":
            return "Protect";
        case "allow":
            return "Allow";
    }
}
