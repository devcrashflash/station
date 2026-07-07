# Dev Crash Flash AI Studio

Minimal Tauri v2 starter using React, JavaScript, Vite, Tailwind CSS, and shadcn/ui.

## Development

- Install dependencies with `pnpm install`.
- Start the frontend with `pnpm dev`.
- Start the desktop app with `pnpm tauri dev`.

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
