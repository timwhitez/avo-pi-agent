# Security

## Secrets

All credentials and provider endpoints are runtime-only environment values.
The repository must never contain real API keys, private endpoint addresses,
ARC credentials, scorecard tokens, or raw request/response logs carrying them.

Run `npm run security:scan` before every commit and push. The scanner checks
tracked project files for likely secrets, literal private provider settings,
IPv4 endpoint literals, and accidental `.env` files.

## Agent permissions

The ARC agent exposes only narrow game and memory tools. It does not expose a
shell, arbitrary filesystem access, browser access, or generic network tools to
the model. Run it in a container when stronger isolation is required.
