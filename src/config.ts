/**
 * Environment / config loader for the Teams channel plugin.
 *
 * Phase 1 stub. Real implementation will:
 *
 *   1. Resolve the state directory (TEAMS_STATE_DIR or ~/.claude/channels/teams).
 *   2. Load <stateDir>/.env into process.env (real env wins).
 *   3. chmod the .env file to 0600 — these are credentials.
 *   4. Validate required keys (TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD,
 *      and TEAMS_BOT_TENANT_ID when TEAMS_BOT_APP_TYPE=SingleTenant).
 *   5. Return a frozen Config object the rest of the plugin consumes.
 *
 * Failure to load a required key writes a helpful diagnostic to stderr and
 * exits non-zero — Claude Code surfaces the message in the MCP startup notice.
 */

export interface Config {
  stateDir: string
  appId: string
  appPassword: string
  appType: 'MultiTenant' | 'SingleTenant' | 'UserAssignedMSI'
  tenantId?: string
  listenHost: string
  listenPort: number
  endpointUrl?: string
  staticAccess: boolean
}

export function loadConfig(): Config {
  throw new Error('not implemented (Phase 1 scaffold)')
}

export {}
