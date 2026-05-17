/**
 * Bot Framework authentication wiring.
 *
 * Builds the `CloudAdapter` we expose to the listener.
 *
 * Security shape:
 *   - `ConfigurationServiceClientCredentialFactory` reads app id / password /
 *     tenant from a config bag we supply. For `MicrosoftAppType=SingleTenant`
 *     the bot connector's JWT must be issued by the pinned tenant — tokens
 *     from other tenants fail validation. The plugin only ships SingleTenant
 *     in v1 (design decision F.1).
 *   - `createBotFrameworkAuthenticationFromConfiguration` plugs the
 *     factory into the framework's token validator. The validator fetches
 *     Microsoft's JWKS, verifies signature, audience, issuer, and tenant.
 *     A forged or replayed activity (e.g. from a random internet attacker
 *     hitting the public endpoint) fails at this layer and the framework
 *     returns 401 to the bot connector.
 *
 * We deliberately do NOT add custom token handling here. Every defensive
 * trick on top of the SDK risks weakening the validator — the SDK already
 * implements the audience/issuer/JWKS rotation. We trust it and add gate
 * logic at the application layer (allowlist) on top.
 */

import { CloudAdapter, ConfigurationServiceClientCredentialFactory, createBotFrameworkAuthenticationFromConfiguration } from 'botbuilder'
import type { Config } from '../config.js'

/**
 * Build a `CloudAdapter` configured for SingleTenant operation.
 *
 * The configuration object passed to the SDK uses the historical names the
 * framework expects (`MicrosoftAppId`, `MicrosoftAppPassword`, etc.). We
 * isolate that mapping here so the rest of the code can use cleaner names.
 */
export function createCloudAdapter(config: Config): CloudAdapter {
  const factory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: config.appId,
    MicrosoftAppPassword: config.appPassword,
    MicrosoftAppType: config.appType,
    MicrosoftAppTenantId: config.tenantId,
  })
  // `null` here means "use the default 'get' lookup against the supplied
  // ConfigurationProvider"; we pass our own `ServiceClientCredentialsFactory`
  // explicitly so the SDK can resolve credentials without a separate config
  // bag. The signature is positional and the SDK accepts a partial
  // ConfigurationBotFrameworkAuthenticationOptions; we pass {}.
  const auth = createBotFrameworkAuthenticationFromConfiguration(
    // No ConfigurationProvider — we passed every value via the factory above.
    null,
    factory,
  )
  return new CloudAdapter(auth)
}
