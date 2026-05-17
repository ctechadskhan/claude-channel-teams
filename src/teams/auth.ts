/**
 * Bot Framework authentication helpers.
 *
 * Phase 1 stub. Real implementation responsibilities:
 *
 *   - Construct the CloudAdapter with ConfigurationServiceClientCredentialFactory
 *     for app id / password / tenant. Single-tenant mode pins the tenant so
 *     tokens issued by other tenants are rejected at the JWT layer.
 *
 *   - Wire BotFrameworkAuthenticationFactory.create so the Bot Connector's
 *     JWKS-signed bearer token on every inbound POST is verified before any
 *     handler runs. Failed verification → 401 returned to the connector and
 *     the activity is dropped.
 *
 *   - Defence-in-depth: even after the framework validates the token, compare
 *     activity.conversation.tenantId against the configured allowed tenant
 *     and refuse cross-tenant deliveries. Belt and braces — protects against
 *     misconfiguration of MultiTenant mode.
 */

export {}
