# Smart Auto Read

Smart Auto Read is a BetterDiscord plugin that automatically marks selected Discord conversations as read. It uses local rules for DMs, group DMs, servers, categories, channels, and threads, while leaving all other conversations alone.

## Features

- Include mode starts with an empty rule set and keeps every conversation unread until you opt in.
- Exclude mode auto-reads supported conversations by default and asks for confirmation before it is enabled.
- Narrower rules override broader rules, from a channel or thread through its category and server.
- Global mention protection defaults to Protect. Each rule can inherit it or select Allow or Protect.
- Preview matches and Apply now handle already unread conversations only when you choose to do so.
- Optional startup reconciliation can process existing unread conversations after a restart.
- Debounce can be disabled for immediate acknowledgements or enabled from 250 to 30,000 milliseconds.
- Scope rows show live names, IDs, profile images, server icons, and clear type labels when Discord provides them.
- Settings and Discord context menus manage the same rules, and menu selections update in place without closing the menu.
- Context controls are available from supported DM, group DM, server, category, channel, thread, message, member, and user menus.
- Privacy-safe diagnostics report status and rule counts without names, IDs, message text, or tokens.

## Include and Exclude examples

In Include mode, a new installation has no rules, so it acknowledges nothing. Add an auto-read rule for a server, category, channel, DM, group DM, or thread to opt that scope in. A narrower Keep unread rule can override a broader auto-read rule.

In Exclude mode, supported conversations are auto-read unless a rule keeps them unread. Enabling this mode needs confirmation because it changes the default behavior. For example, keep one channel unread under an otherwise auto-read server. Mention protection is global by default, and a narrower rule can Allow acknowledgements or Protect mentions again.

## Installation

1. Download `SmartAutoRead.plugin.js` from the repository release you want to install.
2. Open BetterDiscord's Plugins page and select the folder button, or open your BetterDiscord plugins folder directly.
3. Copy `SmartAutoRead.plugin.js` into that folder.
4. Return to the Plugins page and enable Smart Auto Read.

The built file is the only file required for installation.

## Settings and context menus

Open Smart Auto Read from BetterDiscord's Plugins settings to choose Include or Exclude mode, enable or disable debounce, configure startup reconciliation, and choose the global mention policy. When debounce is enabled, its delay can be set from 250 to 30,000 milliseconds. A `debounceMs` value of `0` in an exported configuration means debounce is disabled.

The panel uses BetterDiscord's native settings, layout, text, input, and button components without injecting a plugin stylesheet. Scope rows resolve display names, IDs, profile images, server icons, and scope types live from Discord without adding that presentation data to the saved configuration. The Scopes and Active overrides sections let you set Inherit, Always auto-read, or Keep unread, plus Inherit, Protect, or Allow for mentions.

Use Preview matches before Apply now to review loaded unread conversations that match the current policy. Apply now requires confirmation. Right-click a supported DM, group DM, server, category, channel, thread, message, member, or user and use the Smart Auto Read submenu for the same rule controls. The submenu labels Read behavior and Mention safety explain what each radio group changes. Selecting an item saves the rule, updates the checked option immediately, and keeps the submenu open for another change.

Member and user menus reuse an existing one-to-one DM rule. If no DM exists yet, the submenu explains that the DM must be opened first. Smart Auto Read never creates a conversation on its own.

## Development

This project uses Bun 1.4.0 and the official `@betterdiscord/types` package for the BetterDiscord plugin API.

```sh
bun install
bun run format
bun run lint
bun run typecheck
bun run build
bun run check
```

The build writes `dist/SmartAutoRead.plugin.js`.

## Privacy

Smart Auto Read stores its configuration locally in BetterDiscord's plugin data. It does not collect telemetry, access account tokens, call Discord REST endpoints directly, or store message content. Diagnostics are limited to plugin and BetterDiscord versions, adapter status, numeric settings, rule counts, pending acknowledgement count, and outcome codes.

## Compatibility and terms

Smart Auto Read is not affiliated with, endorsed by, or approved by BetterDiscord or Discord. It depends on Discord internal modules, which can change and may cause the plugin to stop working until it is updated. Review the relevant Discord and BetterDiscord terms before installing client modifications. This project does not claim compatibility with every Discord build.

## License

Released under the [MIT License](LICENSE).
