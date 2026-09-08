# Agent Instructions

This repository is a deterministic, non-production UI fixture.

- Default write scope: `app/**` and `tests/**`, relative to this directory.
  This default does not grant permission to edit other paths; an explicit task
  scope (such as editing this instruction file) may authorize those paths.
- Never add network calls, credentials, authentication, analytics, databases, uploads, or production data.
- Do not install or change dependencies unless the Owner explicitly authorizes it.
- Preserve existing assertions; add or update tests for visible behavior changes.
- Run `node --test tests/source-contract.test.mjs` from this directory before
  producing a UI candidate. For instruction-only edits, check the instructions
  and references; do not claim UI behavior was verified.
- Keep each task bounded and report the purpose of changed files, verification
  evidence, and remaining work. Follow the root rules for user-facing detail.
