# aios-plugin-forma provenance

This formal repository contains a versioned, self-contained Forma Core snapshot
under `core/`. It is prepared for local npm packing and disposable DSH
installation; it is not a GitHub repository and is never pushed automatically.

- Engine source: embedded `core/lib/` and `core/runtime/`
- DSH baseline: `@deepseek-ai/dsh@0.1.3-alpha.2`
- Cordis: `@deepseek-ai/cordis@4.0.2`
- Include: `@deepseek-ai/cordis-plugin-include@1.0.7`
- Node acceptance baseline: `24.14.0`
- Execution boundary: Host registers DTOs; a Supervisor owns a child Worker.
- Safety statement: Node permissions and the child process are defense-in-depth,
  not an OS/container malicious-code sandbox.

The runtime digest covers Host, Worker, Supervisor, package metadata, DTO/spec
files, provenance, license notices, and every embedded Core file. Changes
require regenerating `integrity-manifest.json` and the runtime digest in both
bundle patches before the Host registers any Forma tool.
