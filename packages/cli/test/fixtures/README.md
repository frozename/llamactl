# Test fixtures

Snapshot fixtures for `agent-install-templates.test.ts`. The plist
fixtures are byte-exact comparisons against `buildUserPlist` /
`buildSystemPlist` output. To regenerate after an intentional change,
run `UPDATE_SNAPSHOTS=1 bun test packages/cli/test/agent-install-templates.test.ts`.

## rotate-token-test-fixture.crt

TEST FIXTURE: a public self-signed certificate (`CN=127.0.0.1`, SAN
`IP:127.0.0.1`) used only by `agent-rotate-token.test.ts`. The test copies
it in as `agent.crt` instead of running `agent init`, so it measures token
rotation rather than openssl keygen (#840).

Its private key was discarded after generation and is not used anywhere:
the test writes a non-PEM placeholder `agent.key`, and `agent rotate-token`
never reads that file. To regenerate it:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/x/k.pem && openssl req -x509 -key /tmp/x/k.pem -out packages/cli/test/fixtures/rotate-token-test-fixture.crt -days 36500 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1
```

Then delete the key: only the certificate is committed, and
`scripts/secret-scan.ts` rejects any private key block.
