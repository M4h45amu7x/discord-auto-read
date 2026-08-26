import type { ScopeCatalogNode, ScopePresentationKind } from "../discord/adapter";
import { resolveEffectivePolicy } from "../policy/evaluate";
import type { ScopeRef } from "../policy/model";
import { ruleKey, type MentionPolicy, type ReadDecision, type SettingsV1 } from "../settings/model";

export interface ScopeTreeNode {
    readonly scope: ScopeRef;
    readonly label: string;
    readonly imageUrl?: string;
    readonly kind?: ScopePresentationKind;
    readonly effectiveDecision: Exclude<ReadDecision, "inherit">;
    readonly effectiveMentionPolicy: Exclude<MentionPolicy, "inherit">;
    readonly resolved: boolean;
    readonly children: readonly ScopeTreeNode[];
}

export function buildScopeTree(
    catalog: readonly ScopeCatalogNode[],
    settings: Readonly<SettingsV1>,
): readonly ScopeTreeNode[] {
    const resolvedKeys = new Set<string>();
    const resolved = buildResolvedNodes(catalog, settings, [], resolvedKeys, true);
    const unresolved = Object.entries(settings.rules)
        .filter(([key]) => !resolvedKeys.has(key))
        .map(([, rule]) => {
            const scope = { scopeType: rule.scopeType, scopeId: rule.scopeId };
            const effective = resolveEffectivePolicy(settings, [scope]);
            return freezeNode({
                scope,
                label: `Unresolved ${rule.scopeType}: ${rule.scopeId}`,
                effectiveDecision: effective.decision,
                effectiveMentionPolicy: effective.mentionPolicy,
                resolved: false,
                children: [],
            });
        })
        .sort((left, right) => left.label.localeCompare(right.label));

    return Object.freeze([...resolved, ...unresolved]);
}

export function filterScopeTree(
    tree: readonly ScopeTreeNode[],
    query: string,
): readonly ScopeTreeNode[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return Object.freeze(
        tree.flatMap((node) => {
            const nodeMatches =
                node.label.toLocaleLowerCase().includes(normalizedQuery) ||
                node.scope.scopeId.toLocaleLowerCase().includes(normalizedQuery);
            const children = nodeMatches
                ? node.children.map(cloneNode)
                : filterScopeTree(node.children, normalizedQuery);
            if (!nodeMatches && children.length === 0) {
                return [];
            }
            return [freezeNode({ ...node, children })];
        }),
    );
}

function buildResolvedNodes(
    catalog: readonly ScopeCatalogNode[],
    settings: Readonly<SettingsV1>,
    ancestorPath: readonly ScopeRef[],
    resolvedKeys: Set<string>,
    sortByLabel: boolean,
): readonly ScopeTreeNode[] {
    const sorted = [...catalog].sort((left, right) =>
        compareCatalogNodes(left, right, sortByLabel),
    );
    return Object.freeze(
        sorted.map((catalogNode) => {
            const key = ruleKey(catalogNode.scope.scopeType, catalogNode.scope.scopeId);
            resolvedKeys.add(key);
            const path = [catalogNode.scope, ...ancestorPath];
            const policy = resolveEffectivePolicy(settings, path);
            return freezeNode({
                scope: { ...catalogNode.scope },
                label: catalogNode.label,
                ...(catalogNode.imageUrl ? { imageUrl: catalogNode.imageUrl } : {}),
                ...(catalogNode.kind ? { kind: catalogNode.kind } : {}),
                effectiveDecision: policy.decision,
                effectiveMentionPolicy: policy.mentionPolicy,
                resolved: true,
                children: buildResolvedNodes(
                    catalogNode.children,
                    settings,
                    path,
                    resolvedKeys,
                    catalogNode.scope.scopeType === "all-dms",
                ),
            });
        }),
    );
}

function compareCatalogNodes(
    left: ScopeCatalogNode,
    right: ScopeCatalogNode,
    sortByLabel: boolean,
): number {
    if (!sortByLabel) {
        const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition;
        }
    }
    return left.label.localeCompare(right.label);
}

function cloneNode(node: ScopeTreeNode): ScopeTreeNode {
    return freezeNode({ ...node, children: node.children.map(cloneNode) });
}

function freezeNode(node: ScopeTreeNode): ScopeTreeNode {
    return Object.freeze({
        ...node,
        scope: Object.freeze({ ...node.scope }),
        children: Object.freeze([...node.children]),
    });
}
