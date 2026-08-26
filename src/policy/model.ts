import type { ScopeType } from "../settings/model";
export interface ScopeRef {
    scopeType: ScopeType;
    scopeId: string;
}
export type ChannelContext =
    | { kind: "dm" | "group-dm"; channelId: string }
    | {
          kind: "guild";
          channelId: string;
          guildId: string;
          categoryId?: string;
          parentChannelId?: string;
          thread: boolean;
      }
    | { kind: "unsupported"; channelId: string };
export interface MentionState {
    available: boolean;
    count: number;
}
export type PolicyOutcome =
    | { kind: "auto-read"; matchedScope: ScopeRef | "mode-root" }
    | { kind: "keep-unread"; matchedScope: ScopeRef | "mode-root" }
    | { kind: "protected-mention"; matchedScope: ScopeRef | "global" }
    | { kind: "missing-read-state" }
    | { kind: "unsupported-channel" };
