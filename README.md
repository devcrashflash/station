# Station by DevCrashFlash

Minimal Tauri v2 starter using React, JavaScript, Vite, Tailwind CSS, and shadcn/ui.

## License and 40-day evaluation

Station is **source available**, not open source. It is licensed under the
[Business Source License 1.1](LICENSE). The license permits non-production use
and grants one 40-day period of ordinary production use for evaluation. After
that period, continued production use requires a paid
[commercial license](COMMERCIAL_LICENSE.md); payment is not optional even if the
application remains functional or displays only a reminder.

Each released version automatically becomes available under the Apache License
2.0 four years after that version's first public distribution. Third-party
components remain under their own terms, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Code contributions require acceptance of the
[Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Development

- Install dependencies with `pnpm install`.
- Start the frontend with `pnpm dev`.
- Start the desktop app with `pnpm tauri dev`.

### Google Calendar sign-in

The published desktop Google OAuth client is compiled into the app, so Google sign-in
works without local or build configuration. The Google Calendar API must remain enabled
and the OAuth app must remain available to the intended audience in its Google Cloud
project.

The desktop OAuth flow uses PKCE and a temporary loopback callback. Its installed-app
OAuth client ID and client secret are compiled into the app and must not be treated as
confidential. User calendar credentials are stored unencrypted in the local application
database; anyone with access to that database may be able to read them.

## Release

- Run `pnpm release` to increase the patch version and build an installable macOS DMG.
- Run `pnpm release 0.1.1` (or `pnpm release -- 0.1.1`) to set an explicit version.
- Find the finished `Station_<version>_<architecture>.dmg` installer in
  `src-tauri/target/release/bundle/dmg/`. Version dots are replaced with
  underscores, so an Apple Silicon build of version `0.6.0` produces
  `Station_0_6_0_aarch64.dmg`.

The release command synchronizes the versions in `package.json`, the Tauri config,
and the Rust package files before building. DMG releases must be built on macOS.
The application bundle includes the BSL, commercial license, and third-party
notices under its `legal` resources directory.

## Local-First Behavior

The app should always prefer local data first. Opening projects, tasks, and
resources must render from the local database without waiting for GitHub,
GitLab, Trello, or any other external network request.

Offline use should work for most read and organization workflows. Network
access is only required for actions that explicitly sync external metadata or
edit/modify external systems. Provider sync should be started from foreground
UI, show sync status while it runs, and never block local navigation or local
editing.

## Frontend Structure

The frontend is organized by component responsibility:

```text
src/
  app/                  # App orchestration and shell layout
  components/
    ui/                 # shadcn-generated or shadcn-style primitives
    common/             # reusable app-level compositions
  views/                # screen-level composition
  features/             # domain-specific UI and behavior
  lib/                  # API clients, parsers, and pure utilities
```

Prefer shadcn primitives before creating custom UI. For example, use
`components/ui/breadcrumb.jsx` for generic breadcrumb primitives, then compose
project/task-specific breadcrumb behavior in `features/navigation`. Use
`<Button size="icon">` for icon-only buttons instead of introducing a custom
`IconButton` wrapper unless the app needs additional shared behavior.

Keep domain-aware components out of `components/ui` and `components/common`.
If a component knows about projects, tasks, resources, pull requests, or
connections, it belongs in `features/*` or a screen-level `views/*` module.
