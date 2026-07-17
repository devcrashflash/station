# Dev Crash Flash AI Studio

Minimal Tauri v2 starter using React, JavaScript, Vite, Tailwind CSS, and shadcn/ui.

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
