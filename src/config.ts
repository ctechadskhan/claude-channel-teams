/**
 * Environment / config loader for the Teams channel plugin.
 *
 * Phase 2: real implementation.
 *
 * Responsibilities:
 *   1. Resolve the state directory:
 *      - explicit env (`TEAMS_PLUGIN_STATE_DIR`, or legacy `TEAMS_STATE_DIR`),
 *      - then XDG_DATA_HOME (`$XDG_DATA_HOME/claude/channels/teams`),
 *      - then `~/.local/share/claude/channels/teams` on Linux,
 *      - then `~/.claude/channels/teams` as the fallback / Telegram-aligned default.
 *   2. Load `<stateDir>/.env` into process.env, real env winning.
 *   3. `chmod 0600` the .env so credentials are owner-only (no-op on Windows).
 *   4. Validate required keys.
 *   5. Return a frozen Config object.
 *
 * Failure to load a required key writes a helpful diagnostic to stderr and
 * the caller is expected to exit non-zero. We don't call process.exit here so
 * the function stays testable.
 */

import { chmodSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface Config {
  /** Persistent state dir — credentials, allowlist, future inbox. Mode 0700. */
  stateDir: string
  /** Path to `<stateDir>/allowlist.json`. */
  allowlistFile: string
  /** Bot app (client) ID GUID. */
  appId: string
  /** Bot app client secret. */
  appPassword: string
  /** Always SingleTenant in v1 (design decision F.1). */
  appType: 'SingleTenant'
  /** Tenant GUID — required because we ship single-tenant only. */
  tenantId: string
  /** Address to bind the local HTTP listener (loopback by default). */
  bindHost: string
  /** Port for the local HTTP listener. */
  port: number
}

/**
 * Resolve where state lives. We prefer the explicit env var; otherwise fall
 * back to the same path the official Telegram plugin uses (~/.claude/channels/<name>)
 * so operators familiar with that layout get it for free.
 *
 * Documented in docs/installation.md.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMS_PLUGIN_STATE_DIR) return env.TEAMS_PLUGIN_STATE_DIR
  // Legacy alias, mirrors design.md naming.
  if (env.TEAMS_STATE_DIR) return env.TEAMS_STATE_DIR
  // Anthropic-published channel plugins (Telegram, Discord, iMessage) all
  // resolve to ~/.claude/channels/<name>. Stay consistent.
  return join(homedir(), '.claude', 'channels', 'teams')
}

/**
 * Read `<stateDir>/.env` and merge it into process.env. Real env wins so
 * operators can override per-launch.
 *
 * Security: the `.env` is forced to mode 0600 on every load. A loose mode
 * would mean any other user on the host can read the bot's client secret —
 * a credential equivalent to bot-impersonation.
 */
function loadEnvFile(envFile: string): void {
  let raw: string
  try {
    // Force owner-only perms before reading.
    // No-op on Windows (would need ACLs); harmless if file doesn't exist (we
    // skip via the catch below).
    chmodSync(envFile, 0o600)
    raw = readFileSync(envFile, 'utf8')
  } catch (err) {
    // Missing file is fine — operator may have set everything via real env.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    process.stderr.write(
      `teams channel: failed to read ${envFile}: ${(err as Error).message}\n`,
    )
    return
  }
  for (const line of raw.split('\n')) {
    // Empty lines and `# comments` are ignored; KEY=VALUE only. We don't
    // unquote — operators should write raw values.
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    const [, key, value] = m
    if (key && value !== undefined && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]
  if (!v || v.trim() === '') {
    throw new Error(`teams channel: ${key} is required (set in env or <stateDir>/.env)`)
  }
  return v.trim()
}

/**
 * Load and validate the plugin config. Throws on any required-key miss.
 *
 * The function is intentionally side-effect-light: it makes the state dir if
 * absent (mode 0700 — only the operator should be able to read pending state
 * and conversation references) and chmods .env, but does not start any
 * servers or write the allowlist. Callers do that.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = resolveStateDir(env)
  // Make state dir owner-only — same hardening Telegram does.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  const envFile = join(stateDir, '.env')
  loadEnvFile(envFile)
  // Re-read after the file load — process.env is now fully populated.
  env = process.env

  const appId = required(env, 'TEAMS_BOT_APP_ID')
  const appPassword = required(env, 'TEAMS_BOT_APP_PASSWORD')
  const tenantId = required(env, 'TEAMS_BOT_TENANT_ID')

  const bindHost = env.TEAMS_PLUGIN_BIND_HOST?.trim() || '127.0.0.1'
  const portStr = env.TEAMS_PLUGIN_PORT?.trim() || '3979'
  const port = Number.parseInt(portStr, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`teams channel: TEAMS_PLUGIN_PORT must be 1..65535 (got ${portStr})`)
  }

  return Object.freeze({
    stateDir,
    allowlistFile: join(stateDir, 'allowlist.json'),
    appId,
    appPassword,
    appType: 'SingleTenant' as const,
    tenantId,
    bindHost,
    port,
  })
}
