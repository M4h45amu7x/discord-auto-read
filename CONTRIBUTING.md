# Contributing

Thanks for considering a contribution.

## Development setup

- Use Bun 1.4.0.
- Install the locked dependencies with `bun install --frozen-lockfile`.
- Run `bun run check` before opening a pull request.
- Use `@betterdiscord/types` for the public BetterDiscord API. Keep local types limited to Discord internals that BetterDiscord does not expose.
- Keep internal text and comments concise, clear English.
- Discuss any new runtime dependency before adding it.

## Pull requests

Keep each pull request focused. Explain the behavior change, document manual verification, and avoid unrelated formatting or generated file changes.
