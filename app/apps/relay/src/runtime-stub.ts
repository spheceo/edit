/**
 * Stand-ins for the Workers runtime's own modules (`cloudflare:workers`,
 * `cloudflare:workflows`) where the relay's code runs outside it: its tests,
 * under the web app's vitest (vite.config.ts aliases them here).
 */

export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class NonRetryableError extends Error {}
