# Security policy

DevContinuity reads the history of AI coding agents, which can contain source code, file paths and, occasionally, secrets. It is designed to stay on your machine:

- It only answers requests from `localhost`, and every API call needs a local token.
- Agents' original files are never modified; credential files are never read.
- Secrets are redacted before anything is stored, exported or sent to an AI provider.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include steps to reproduce and the version (`/api/health` shows it).

You can expect an acknowledgement within a week.

## Supported versions

Only the latest release on the `main` branch receives security fixes.
