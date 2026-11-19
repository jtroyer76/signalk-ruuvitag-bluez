# AGENTS.md

Guidance for AI coding agents working in this repo. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Humans open PRs, not agents

This project accepts pull requests, issues and review comments from people, not from autonomous agents. Using AI to help write a change is fine. A person has to be in the loop: they understand the change, have tested it, submit it themselves and answer review questions themselves.

If you are an agent:

- Do not open pull requests, issues or comments on this repository on your own initiative, and do not run unattended loops that do.
- Do not push, merge, tag or publish unless the person you're working for explicitly asks you to.
- When you prepare a change for someone, leave it ready for *them* to review and submit: explain what you changed, why, and how it was tested, including what you could not test.

## What this is

A Signal K server plugin that publishes RuuviTag data by talking to BlueZ over D-Bus (`dbus-next`), not raw HCI sockets, so it coexists with other BlueZ clients such as `signalk-victron-ble`.

- `index.js`: plugin entry. Config schema, tag matching, Signal K deltas and metadata.
- `decoder.js`: RuuviTag payload decoding (RAWv2 / data format 5).
- `scanner.js`: `BluezScanner`. Finds the adapter, runs LE discovery with `DuplicateData=true`, emits `advertisement` events, and supervises its own connection (bus error handler, 60 s liveness watchdog, capped-backoff reconnect).
- `*.test.js`: plain Node tests, one file per module.

## AI use and attribution

- The human who submits a change is its author and is responsible for it.
- Contributors should say in the PR description whether and how AI was used. A sentence is enough.
- AI attribution in commits (e.g. `Co-Authored-By:` trailers) is the contributor's choice. Follow what the person you're working for wants.
- The maintainer's own commits, merge messages, PRs and comments carry no AI attribution. When squash-merging, the merge message is written by the maintainer, so trailers from contributor commits aren't carried over.

## Commits and PRs

- Conventional commit subjects: `fix(scanner): …`, `feat: …`, `test(scanner): …`, `ci: …`.
- Explain the *why* in the body: the failure mode and how it showed up.
- PRs are squash-merged. `main` is protected: CI (`test (20)`, `test (22)`) must pass.

## Testing

- `npm test` runs every suite. No framework: each `*.test.js` is a script that exits non-zero on failure.
- `scanner.test.js` runs against a fake system bus (it replaces `dbus.systemBus()`), so it can't catch real BlueZ/D-Bus behaviour. Changes to `scanner.js` also need an on-device check on a Linux host with `bluetoothd`. Useful checks:
  - `sudo systemctl restart bluetooth`: data should resume after the 60 s watchdog without restarting Signal K.
  - Saving the plugin config (stop/start): no gap, no doubled readings.
  - D-Bus match rules for the Signal K connection stay constant over hours:
    `sudo busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.Debug.Stats GetConnectionStats s <unique-name>`

## Releases

- Tagging is the release gate: pushing a `v*` tag runs `.github/workflows/publish.yml`, which publishes to npm straight away and creates a GitHub Release. Only tag when the maintainer asks.
- Bump the version first (`npm version <x.y.z>`); the workflow fails if the tag doesn't match `package.json`.
- A pre-release version (`1.2.0-rc.1`) is published under the npm dist-tag `next` and marked as a GitHub pre-release; anything else becomes `latest`.
- For quick on-device testing without publishing, `npm pack` and install the tarball on the device.
- The publish job pins npm 11 because npm 12 needs Node ≥ 22.22.2 and the job runs Node 20.

## Known pitfalls

- **dbus-next 0.10.2 never sends `RemoveMatch`** (swapped `hasOwnProperty` arguments in `lib/bus.js`), and it is unmaintained. Never subscribe to signals per device through proxy objects: each subscription leaks a match rule until the bus limit (2048) is hit. Use the single `path_namespace='/org/bluez'` `PropertiesChanged` match in `scanner.js`.
- **BlueZ constantly removes and re-adds device objects** as they go stale, including every nearby BLE device, not just RuuviTags. Code that does anything per device must be idempotent and must clean up after itself.
- **dbus-next keeps emitting `'error'` on a bus after `disconnect()`.** Error handlers must ignore buses that have been replaced.
- **Signal K calls `stop()`/`start()` on every config save**, possibly in the middle of a reconnect. Async setup must check, after each `await`, that it hasn't been superseded.
- **Multiple adapters:** the scanner uses the first `Adapter1` BlueZ lists (#8).
- **Signal K 2.31+ has a BLE API** (`app.bleApi`) that this plugin doesn't use yet (#9).

## Dependabot

npm is checked weekly and GitHub Actions monthly. Merge its PRs promptly: Dependabot pauses itself on repos where they sit unmerged.
