# DeepSeek Harness

English

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Download for macOS

Anton is the macOS app for this harness: a menu-bar controller that supervises the harness, serves its web UI through a loopback bridge, and adds a browser driver and macOS notifications to the agent.

- [Anton 0.1.0 — Apple silicon (.dmg)](https://github.com/AntonFoundry/antoncode/releases/download/v0.1.0/Anton-0.1.0-arm64.dmg)
- [All releases](https://github.com/AntonFoundry/antoncode/releases)

The build is ad-hoc signed and not notarized: on first launch, right-click **Anton** → **Open**. Requires macOS 13 or newer on Apple silicon. First launch installs the `anton` CLI into `~/.local/bin` and creates an app-owned harness home at `~/Library/Application Support/Anton/dsh`, separate from a developer `~/.dsh`.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md). To extend the harness — tools, hooks, UI plugins, or full one-click app surfaces — follow the [extension cookbook](docs/cookbook/extension-cookbook.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
