# Third-Party Notices

Station by DevCrashFlash contains third-party software. Those components are not
licensed under Station's Business Source License; their respective license terms
continue to apply.

The application directly uses components from these projects:

- Tauri and its official JavaScript/Rust plugins — MIT or Apache-2.0
- React and React DOM — MIT
- Tailwind CSS — MIT
- Radix UI — MIT
- xterm.js and its addons — MIT
- Lucide — ISC
- Prism and prism-react-renderer — MIT
- SQLite through rusqlite — MIT; bundled SQLite is public domain
- reqwest — MIT or Apache-2.0
- serde and serde_json — MIT or Apache-2.0
- chrono and chrono-tz — MIT or Apache-2.0
- tauri-nspanel — MIT or Apache-2.0
- OCR and image-processing dependencies including `image`, `ocrs`, and `rten`
  — licenses stated by their respective distributions

The complete, version-specific dependency set is recorded in `pnpm-lock.yaml`
and `src-tauri/Cargo.lock`. Copyright notices and full license texts distributed
with each dependency are incorporated by reference and remain applicable. A
binary distributor must review the locked dependency set and include any
additional notices required by the exact versions being shipped.
