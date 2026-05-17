/**
 * Allowlist persistence — reads/writes <stateDir>/access.json.
 *
 * Phase 1 stub. Real implementation mirrors the Telegram plugin pattern:
 *
 *   - readAccess()   — load and parse access.json. ENOENT → defaultAccess().
 *                      Corruption → move aside as .corrupt-<ts> and start fresh.
 *
 *   - saveAccess(a)  — write atomically: write to access.json.tmp with mode
 *                      0600, then rename. Skip writes in static mode.
 *
 *   - pruneExpired() — drop entries whose expiresAt has passed. Called on
 *                      every inbound gate evaluation so stale codes don't
 *                      accumulate.
 *
 *   - assertAllowedConversation(id) — used by outbound tools to enforce the
 *                      same gate the inbound side does. Throws on miss.
 *
 *   - defaultAccess() — { dmPolicy: 'pairing', allowFrom: [], groups: {},
 *                        pending: {} }.
 *
 * The /teams:access skill (lives outside this file, see docs/pairing.md)
 * also reads/writes this file from Claude Code's terminal session. The
 * channel server picks up changes on the next inbound activity — no restart.
 */

export {}
