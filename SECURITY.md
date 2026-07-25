# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub's
[Report a vulnerability](https://github.com/romirom11/ordi/security/advisories/new)
form, which creates a private advisory only maintainers can see.

Please include what the issue is, how to reproduce it, and what an attacker gains.
A proof of concept helps but is not required.

You can expect an acknowledgement within a few days and an assessment within two
weeks. ordi is maintained by a small team, so please be patient with fixes for
lower-severity issues – and let us know if you plan to disclose publicly, so we
can coordinate.

## Supported versions

Fixes land on the latest release. There are no long-term support branches; if you
run ordi in production, track the current release.

## Scope

In scope: authentication and session handling, the permission system, tenant data
exposure through the API or MCP server, injection of any kind, secrets handling,
and the public surfaces (invoice and quote pages, client portal, intake forms,
careers pages).

Out of scope: anything that requires a compromised server or database, denial of
service through resource exhaustion on a self-hosted instance you control, and
findings from automated scanners without a demonstrated impact.

## Notes for operators

A few things worth knowing when you deploy ordi:

- **Module toggles are a UI concern, not a security boundary.** Turning a module
  off hides it from the interface; the API still serves its data to anyone whose
  role permits it. Use roles and permissions to restrict access.
- **API tokens carry the permissions of the role that created them**, including
  tokens used by the MCP server. Scope agent tokens to a limited role.
- **Secrets** (git tokens, Slack tokens, IMAP passwords) are encrypted at rest
  with AES-GCM using `ENCRYPTION_KEY`. Set it to a strong random value and back it
  up – losing it means losing access to those integrations.
- **Set `CORS_ORIGINS`** to your real origins. Desktop origins are always allowed
  because the desktop app authenticates with bearer tokens.
- Put ordi behind TLS. Session cookies are secure and same-site, which means they
  will not survive a plain-HTTP deployment.
