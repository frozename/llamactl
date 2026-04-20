# Test fixtures

Snapshot fixtures for `agent-install-templates.test.ts`. The plist
fixtures are byte-exact comparisons against `buildUserPlist` /
`buildSystemPlist` output. To regenerate after an intentional change,
run `UPDATE_SNAPSHOTS=1 bun test packages/cli/test/agent-install-templates.test.ts`.
