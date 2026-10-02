# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email the author directly: manish.bps3@gmail.com

Include a description of the issue, steps to reproduce, and the potential impact.
You can expect an initial response within a few business days. We will work with
you to understand and address the issue before any public disclosure.

## Self-hosted instances

Self-hosted instances are the operator's own responsibility to secure and keep
updated. This includes network exposure, TLS termination, and keeping the
underlying container image and dependencies up to date. Follow the principle of
least privilege: do not expose the API port to the public internet unless you
intend to.

## Supported versions

Only the latest release on `main` receives security fixes.
