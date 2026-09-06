# Dependabot triage — 2026-09-06

**Scope:** triage only; no dependency bumps, no `package.json`/`bun.lock` edits.

**Source:** `bun audit` run in the worktree. `gh` was not installed in this environment, so the GitHub Dependabot API could not be queried; the alert counts therefore differ from the GitHub UI summary (GitHub quoted 25 alerts; `bun audit` reports the full installed lockfile and finds more, including dev and transitive packages).

## Verdict

`bun audit` found **96 advisory instances** across **24 packages**: 1 critical, 44 high, 44 moderate, 7 low. Of the **18 high-severity packages**, only **two** are on a reachable request/credential path that justifies urgent action:

1. `undici` 7.18.0 — used by the Electron tRPC client that talks to remote nodes with pinned TLS + bearer tokens.
2. `electron` 41.2.1 — the app runtime; the renderer-isolation bugs are reachable but mitigated by `contextIsolation: true`, `nodeIntegration: false`, and origin/IPc guards.

A third package, `fast-uri` 3.1.0, is reachable through the MCP SDK's schema validation of tool arguments, but the MCP transport is stdio-only and local, so its practical impact is much lower than `undici`/`electron`.

Everything else in the high list is build-time or unreachable at runtime: `electron-builder`/`app-builder-lib`/`builder-util-runtime`/`tar`/`tmp`/`extract-zip`, `vite`/`postcss`/`nanoid`/`browserslist`/`brace-expansion` (dev/build), and `ws`/`form-data`/`ip-address`/`js-yaml`/`hono` in `@kubernetes/client-node` / MCP SDK paths that are not exercised by this code.

## 1. Full inventory

Package, installed version(s), severity, advisory ID, title, and first available fixed version from npm. CVEs are shown where the GitHub Advisory API returned one for a high-severity GHSA; otherwise the advisory ID is the GHSA only (CONFIRMED from `bun audit`; CVEs CONFIRMED from `curl https://api.github.com/advisories/<GHSA>` for high items).

| Package | Installed | Severity | Advisory | CVE | Title | Fixed |
|---------|-----------|----------|----------|-----|-------|-------|
| tar | 7.5.13 | critical | `GHSA-23hp-3jrh-7fpw` |  | node-tar: Decompression/parse DoS via unlimited input | 7.5.19 |
| app-builder-lib | 26.8.1 | high | `GHSA-7g7r-gx96-252g` | CVE-2026-54672 | electron-updater: Uncontrolled search path elements within `AppImage` built by `app-builder-lib` | 26.15.0 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-3jxr-9vmj-r5cp` | CVE-2026-13149 | brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups | 2.1.2 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-3jxr-9vmj-r5cp` | CVE-2026-13149 | brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups | 1.1.16 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-3jxr-9vmj-r5cp` | CVE-2026-13149 | brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups | 5.0.7 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-mh99-v99m-4gvg` | CVE-2026-14257 | brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash | 1.1.17 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-mh99-v99m-4gvg` | CVE-2026-14257 | brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash | 2.1.3 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-mh99-v99m-4gvg` | CVE-2026-14257 | brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash | 5.0.8 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-rgw5-rvv9-x895` | CVE-2026-69152 | brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation | 5.0.9 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-rgw5-rvv9-x895` | CVE-2026-69152 | brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation | 2.1.4 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | high | `GHSA-rgw5-rvv9-x895` | CVE-2026-69152 | brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation | 1.1.18 |
| browserslist | 4.28.2 | high | `GHSA-73wf-gq98-2v4g` | CVE-2026-73088 | Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) | 4.28.7 |
| browserslist | 4.28.2 | high | `GHSA-c83g-rgw3-j3cx` | CVE-2026-73089 | Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM | 4.28.7 |
| builder-util-runtime | 9.5.1 | high | `GHSA-p2f4-r6v6-j797` | CVE-2026-54673 | electron-updater: Cross-origin redirect leaks `PRIVATE-TOKEN` and mixed-case `Authorization` credentials in `builder-util-runtime` | 9.7.0 |
| electron | 41.2.1 | high | `GHSA-9f4c-93c8-jc8g` | CVE-2026-70608 | Electron: Sandboxed iframe can bypass the allow-popups restriction via the OpenURL navigation path | 41.10.3 |
| electron | 41.2.1 | high | `GHSA-h7rp-cf8h-j98x` | CVE-2026-70601 | Electron: Context isolation bypass via Function.prototype.bind hijack | 41.2.2 |
| electron | 41.2.1 | high | `GHSA-v3j7-r9gq-3gjw` | CVE-2026-70604 | Electron: Custom protocol with supportFetchAPI but not corsEnabled allows cross-origin reads | 41.4.0 |
| extract-zip | 2.0.1 | high | `GHSA-jmr9-qjv8-65gv` | CVE-2026-56876 | extract-zip unvalidated symlink path traversal | unknown |
| fast-uri | 3.1.0 | high | `GHSA-4c8g-83qw-93j6` | CVE-2026-13676 | fast-uri vulnerable to host confusion via failed IDN canonicalization | 3.1.3 |
| fast-uri | 3.1.0 | high | `GHSA-7p8r-x3mc-p8w7` | CVE-2026-18446 | fast-uri vulnerable to host confusion via backslash authority introducer | 3.1.5 |
| fast-uri | 3.1.0 | high | `GHSA-f65p-4m7j-42xc` | CVE-2026-75975 | fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization | 3.1.6 |
| fast-uri | 3.1.0 | high | `GHSA-jqff-g426-hqxp` | CVE-2026-76172 | fast-uri vulnerable to host confusion via percent-encoded scheme normalization | 3.1.6 |
| fast-uri | 3.1.0 | high | `GHSA-q3j6-qgpj-74h6` | CVE-2026-6321 | fast-uri vulnerable to path traversal via percent-encoded dot segments | 3.1.1 |
| fast-uri | 3.1.0 | high | `GHSA-v2hh-gcrm-f6hx` | CVE-2026-16221 | fast-uri vulnerable to host confusion via literal backslash authority delimiter | 3.1.4 |
| fast-uri | 3.1.0 | high | `GHSA-v39h-62p7-jpjc` | CVE-2026-6322 | fast-uri vulnerable to host confusion via percent-encoded authority delimiters | 3.1.2 |
| form-data | 4.0.5 | high | `GHSA-hmw2-7cc7-3qxx` | CVE-2026-12143 | form-data: CRLF injection in form-data via unescaped multipart field names and filenames | 4.0.6 |
| hono | 4.12.14 | high | `GHSA-88fw-hqm2-52qc` | CVE-2026-54290 | hono: CORS Middleware reflects any Origin with credentials when `origin` defaults to the wildcard | 4.12.25 |
| ip-address | 10.1.0 | high | `GHSA-mwp4-54f8-5fhr` | CVE-2026-69192 | ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass | 10.3.1 |
| js-yaml | 4.1.1 | high | `GHSA-52cp-r559-cp3m` | CVE-2026-59869 | js-yaml: YAML merge-key chains can force quadratic CPU consumption | 4.3.0 |
| js-yaml | 4.1.1 | high | `GHSA-5p4m-2wfm-xmqj` |  | JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported | 4.3.1 |
| nanoid | 3.3.11 | high | `GHSA-28wg-ghj8-5hjv` | CVE-2026-67214 | nanoid: non-secure generators can loop indefinitely with negative size | 3.3.16 |
| nanoid | 3.3.11 | high | `GHSA-2v37-7h3g-55p8` | CVE-2026-67213 | nanoid: custom generators can loop indefinitely when size is zero | 3.3.18 |
| nanoid | 3.3.11 | high | `GHSA-xwg4-73v4-xw9w` | CVE-2026-73086 | nanoid: Integer Overflow or Wraparound | 3.3.12 |
| postcss | 8.5.10 | high | `GHSA-6g55-p6wh-862q` | CVE-2026-45623 | PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments | 8.5.12 |
| postcss | 8.5.10 | high | `GHSA-r28c-9q8g-f849` | CVE-2026-73646 | PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure | 8.5.18 |
| tar | 7.5.13 | high | `GHSA-8x88-c5mf-7j5w` | CVE-2026-59874 | node-tar: Negative tar entry size causes infinite loop in archive replace | 7.5.18 |
| tar | 7.5.13 | high | `GHSA-r292-9mhp-454m` | CVE-2026-73566 | node-tar: Uncontrolled recursion in mapHas/filesFilter allows uncatchable stack-overflow DoS via crafted long-path tar with member selection | 7.5.21 |
| tmp | 0.2.5 | high | `GHSA-ph9p-34f9-6g65` | CVE-2026-44705 | tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape | 0.2.6 |
| undici | 7.18.0 | high | `GHSA-4cwx-7wf7-3272` | CVE-2026-13697 | undici vulnerable to cross-user information disclosure and parse-time crash via degenerate private cache directives | 7.29.0 |
| undici | 7.18.0 | high | `GHSA-f269-vfmq-vjvj` | CVE-2026-1528 | Undici: Malicious WebSocket 64-bit length overflows parser and crashes the client | 7.24.0 |
| undici | 7.18.0 | high | `GHSA-v9p9-hfj2-hcw8` | CVE-2026-2229 | Undici has Unhandled Exception in WebSocket Client Due to Invalid server_max_window_bits Validation | 7.24.0 |
| undici | 7.18.0 | high | `GHSA-vrm6-8vpv-qv8q` | CVE-2026-1526 | Undici has Unbounded Memory Consumption in WebSocket permessage-deflate Decompression | 7.24.0 |
| undici | 7.18.0 | high | `GHSA-vxpw-j846-p89q` | CVE-2026-12151 | undici WebSocket client vulnerable to denial of service via fragment count bypass | 7.28.0 |
| vite | 7.3.2 | high | `GHSA-fx2h-pf6j-xcff` | CVE-2026-53571 | vite: `server.fs.deny` bypass on Windows alternate paths | 7.3.5 |
| ws | 8.20.0 | high | `GHSA-96hv-2xvq-fx4p` | CVE-2026-48779 | ws: Memory exhaustion DoS from tiny fragments and data chunks | 8.21.0 |
| @hono/node-server | 1.19.14 | moderate | `GHSA-frvp-7c67-39w9` |  | Node.js Adapter for Hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`) | 1.19.15 |
| @xmldom/xmldom | 0.8.13 | moderate | `GHSA-6gmq-8vp8-gcm6` |  | xmldom: XML fragment injection via invalid EntityReference.nodeName during requireWellFormed serialization | 0.8.15 |
| brace-expansion | 2.1.0, 5.0.5, 1.1.14 | moderate | `GHSA-jxxr-4gwj-5jf2` |  | brace-expansion: Large numeric range defeats documented `max` DoS protection | 5.0.6 |
| electron | 41.2.1 | moderate | `GHSA-ff2p-hmqr-hxm4` |  | Electron: contextBridge object copy honors prototype setters | 41.2.2 |
| electron | 41.2.1 | moderate | `GHSA-r4w5-6pfg-jxp5` |  | Electron: ProtocolResponse.url reuses the default session cache instead of the registering session | 41.9.1 |
| hono | 4.12.14 | moderate | `GHSA-2gcr-mfcq-wcc3` |  | Hono: app.mount() strips mount prefix using undecoded path, causing incorrect routing for percent-encoded paths | 4.12.21 |
| hono | 4.12.14 | moderate | `GHSA-3hrh-pfw6-9m5x` |  | Hono: Cookie helper does not sanitize sameSite and priority, allowing Set-Cookie injection | 4.12.21 |
| hono | 4.12.14 | moderate | `GHSA-54fx-42gc-7vw4` |  | Hono: Algorithmic Complexity DoS in Language Middleware | 4.12.34 |
| hono | 4.12.14 | moderate | `GHSA-69xw-7hcm-h432` |  | hono/jsx has Unvalidated JSX Tag Names that May Allow HTML Injection | 4.12.16 |
| hono | 4.12.14 | moderate | `GHSA-8j4g-w8fx-2239` |  | Hono: ReDoS in CORS middleware via Access-Control-Request-Headers | 4.12.34 |
| hono | 4.12.14 | moderate | `GHSA-9vqf-7f2p-gf9v` |  | Hono: bodyLimit() can be bypassed for chunked / unknown-length requests | 4.12.16 |
| hono | 4.12.14 | moderate | `GHSA-f23p-vx2j-j53r` |  | Hono: `memo()` retains SSR output across requests, leading to cross-user data disclosure | 4.12.34 |
| hono | 4.12.14 | moderate | `GHSA-f577-qrjj-4474` |  | Hono: JWT middleware accepts any Authorization scheme, not only Bearer | 4.12.21 |
| hono | 4.12.14 | moderate | `GHSA-hvrm-45r6-mjfj` |  | hono/jsx does not isolate context per request, leading to cross-request data disclosure | 4.12.27 |
| hono | 4.12.14 | moderate | `GHSA-j6c9-x7qj-28xf` |  | hono: AWS Lambda adapter merges multiple `Set-Cookie` headers into one value, dropping cookies on ALB single-header and Lattice | 4.12.25 |
| hono | 4.12.14 | moderate | `GHSA-p77w-8qqv-26rm` |  | Hono's Cache Middleware ignores Vary: Authorization / Vary: Cookie leading to cross-user cache leakage | 4.12.18 |
| hono | 4.12.14 | moderate | `GHSA-qp7p-654g-cw7p` |  | Hono has CSS Declaration Injection via Style Object Values in JSX SSR | 4.12.18 |
| hono | 4.12.14 | moderate | `GHSA-rv63-4mwf-qqc2` |  | hono: Body Limit Middleware can be bypassed on AWS Lambda by understating `Content-Length` | 4.12.25 |
| hono | 4.12.14 | moderate | `GHSA-w62v-xxxg-mg59` |  | Hono: Server-Side XSS via JSX Escaping Bypass in cx() Utility | 4.12.27 |
| hono | 4.12.14 | moderate | `GHSA-wgpf-jwqj-8h8p` |  | hono: Lambda@Edge adapter keeps only the last value of a repeated request header, dropping the rest | 4.12.25 |
| hono | 4.12.14 | moderate | `GHSA-wwfh-h76j-fc44` |  | hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`) | 4.12.25 |
| hono | 4.12.14 | moderate | `GHSA-xgm2-5f3f-mvvc` |  | Hono: API Gateway v1 adapter can drop a distinct repeated request header value during de-duplication | 4.12.27 |
| hono | 4.12.14 | moderate | `GHSA-xrhx-7g5j-rcj5` |  | Hono: IP Restriction bypasses static deny rules for non-canonical IPv6  | 4.12.21 |
| ip-address | 10.1.0 | moderate | `GHSA-v2v4-37r5-5v8g` |  | ip-address has XSS in Address6 HTML-emitting methods | 10.1.1 |
| js-yaml | 4.1.1 | moderate | `GHSA-h67p-54hq-rp68` |  | JS-YAML: Quadratic-complexity DoS in merge key handling via repeated aliases | 4.2.0 |
| postcss | 8.5.10 | moderate | `GHSA-fxqj-rqcc-2cmp` |  | PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset | 8.5.23 |
| qs | 6.15.1 | moderate | `GHSA-4mjr-xmp4-gh2g` |  | qs: Denial of Service via Attacker Controlled isBuffer | 6.16.0 |
| qs | 6.15.1 | moderate | `GHSA-q8mj-m7cp-5q26` |  | qs has a remotely triggerable DoS: qs.stringify crashes with TypeError on null/undefined entries in comma-format arrays when encodeValuesOnly is set | 6.15.2 |
| qs | 6.15.1 | moderate | `GHSA-x5fp-wj9c-mxmx` |  | qs array-limit bypass via bracket-key comma parsing | 6.16.0 |
| tar | 7.5.13 | moderate | `GHSA-gvwx-54wh-qm9j` |  | node-tar: Uncaught Exception DoS via NUL byte in PAX path/linkpath records | 7.5.17 |
| tar | 7.5.13 | moderate | `GHSA-vmf3-w455-68vh` |  | node-tar applies PAX size override to intermediary GNU long-name/long-link headers, causing tar parser interpretation differential (file smuggling) | 7.5.16 |
| tar | 7.5.13 | moderate | `GHSA-w8wr-v893-vjvp` |  | node-tar: Process crash via PAX numeric path type confusion | 7.5.18 |
| undici | 7.18.0 | moderate | `GHSA-2mjp-6q6p-2qxm` |  | Undici has an HTTP Request/Response Smuggling issue | 7.24.0 |
| undici | 7.18.0 | moderate | `GHSA-4992-7rv2-5pvq` |  | Undici has CRLF Injection in undici via `upgrade` option | 7.24.0 |
| undici | 7.18.0 | moderate | `GHSA-8xcm-r25x-g524` |  | undici vulnerable to downstream response desynchronization via retry interceptor | 7.29.0 |
| undici | 7.18.0 | moderate | `GHSA-g9mf-h72j-4rw9` |  | Undici has an unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion | 7.18.2 |
| undici | 7.18.0 | moderate | `GHSA-jr45-8vmc-qm54` |  | undici vulnerable to cross-user information disclosure via whitespace around equals in Cache-Control directives | 7.29.0 |
| undici | 7.18.0 | moderate | `GHSA-m8rv-5g2x-5cg5` |  | undici vulnerable to CRLF Injection via blob-like body 'type' property | 7.29.0 |
| undici | 7.18.0 | moderate | `GHSA-p88m-4jfj-68fv` |  | undici vulnerable to HTTP header injection via Set-Cookie percent-decoding | 7.28.0 |
| undici | 7.18.0 | moderate | `GHSA-phc3-fgpg-7m6h` |  | Undici has Unbounded Memory Consumption in its DeduplicationHandler via Response Buffering that leads to DoS | 7.24.0 |
| undici | 7.18.0 | moderate | `GHSA-pr7r-676h-xcf6` |  | undici vulnerable to cross-user information disclosure via shared cache whitespace bypass | 7.28.0 |
| undici | 7.18.0 | moderate | `GHSA-v3r7-h72x-cjcm` |  | undici vulnerable to cookie attribute injection via unsanitized domain and unparsed setCookie fields | 7.29.0 |
| vite | 7.3.2 | moderate | `GHSA-v6wh-96g9-6wx3` |  | launch-editor: NTLMv2 hash disclosure via UNC path handling on Windows | 7.3.5 |
| ws | 8.20.0 | moderate | `GHSA-58qx-3vcg-4xpx` |  | ws: Uninitialized memory disclosure | 8.20.1 |
| @babel/core | 7.29.0 | low | `GHSA-4x5r-pxfx-6jf8` |  | @babel/core: Arbitrary File Read via sourceMappingURL Comment | 7.29.6 |
| body-parser | 2.2.2 | low | `GHSA-v422-hmwv-36x6` |  | body-parser vulnerable to denial of service when invalid limit value silently disables size enforcement | 2.3.0 |
| esbuild | 0.25.12, 0.27.7 | low | `GHSA-g7r4-m6w7-qqqr` |  | esbuild allows arbitrary file read when running the development server on Windows | 0.28.1 |
| hono | 4.12.14 | low | `GHSA-79qm-7rj5-m7r9` |  | Hono: Proxy Helper does not remove response headers listed in the `Connection` header | 4.12.34 |
| hono | 4.12.14 | low | `GHSA-hm8q-7f3q-5f36` |  | Hono has improper validation of NumericDate claims (exp, nbf, iat) in JWT verify() | 4.12.18 |
| undici | 7.18.0 | low | `GHSA-35p6-xmwp-9g52` |  | undici vulnerable to HTTP response queue poisoning via keep-alive socket reuse | 7.28.0 |
| undici | 7.18.0 | low | `GHSA-g8m3-5g58-fq7m` |  | undici vulnerable to Set-Cookie SameSite attribute downgrade via permissive substring matching | 7.28.0 |

## 2. High-severity findings: dependency chain and reachability

For each high package: whether it is a **direct** dependency or **transitive**, the parent(s), how it is used in this repo, whether the vulnerable code path is reachable, and the recommended bump.

### app-builder-lib (26.8.1)

- **Direct/transitive:** transitive
- **Parent(s):** dmg-builder@26.8.1 / electron-builder@26.8.1 / electron-builder-squirrel-windows@26.8.1
- **Recommended bump to clear all high findings:** `26.15.0`
- **Advisories:**
  - `GHSA-7g7r-gx96-252g`, CVE: `CVE-2026-54672` — electron-updater: Uncontrolled search path elements within `AppImage` built by `app-builder-lib` — fixed at `26.15.0`
- **Reachability / reasoning:**
  - Transitive via `electron-builder` (CONFIRMED).
  - Build-only; the AppImage LD_LIBRARY_PATH bug is only relevant when building AppImage artifacts. Bumping `electron-builder` to 26.15.0+ will pull this.

### brace-expansion (2.1.0, 5.0.5, 1.1.14)

- **Direct/transitive:** transitive
- **Parent(s):** minimatch@3.1.5 / minimatch@9.0.9 / minimatch@5.1.9 / minimatch@10.2.5
- **Recommended bump to clear all high findings:** `5.0.9`
- **Advisories:**
  - `GHSA-mh99-v99m-4gvg`, CVE: `CVE-2026-14257` — brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash — fixed at `1.1.17`
  - `GHSA-mh99-v99m-4gvg`, CVE: `CVE-2026-14257` — brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash — fixed at `2.1.3`
  - `GHSA-mh99-v99m-4gvg`, CVE: `CVE-2026-14257` — brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash — fixed at `5.0.8`
  - `GHSA-rgw5-rvv9-x895`, CVE: `CVE-2026-69152` — brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation — fixed at `5.0.9`
  - `GHSA-rgw5-rvv9-x895`, CVE: `CVE-2026-69152` — brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation — fixed at `2.1.4`
  - `GHSA-rgw5-rvv9-x895`, CVE: `CVE-2026-69152` — brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation — fixed at `1.1.18`
  - `GHSA-3jxr-9vmj-r5cp`, CVE: `CVE-2026-13149` — brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups — fixed at `2.1.2`
  - `GHSA-3jxr-9vmj-r5cp`, CVE: `CVE-2026-13149` — brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups — fixed at `1.1.16`
  - `GHSA-3jxr-9vmj-r5cp`, CVE: `CVE-2026-13149` — brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups — fixed at `5.0.7`
- **Reachability / reasoning:**
  - Transitive via multiple `minimatch` versions used by ESLint and `@electron/*` build tools (CONFIRMED).
  - No runtime globbing on attacker-controlled patterns. Build/dev only.

### browserslist (4.28.2)

- **Direct/transitive:** transitive
- **Parent(s):** @babel/helper-compilation-targets@7.28.6 / core-js-compat@3.49.0 / peer update-browserslist-db@1.2.3
- **Recommended bump to clear all high findings:** `4.28.7`
- **Advisories:**
  - `GHSA-c83g-rgw3-j3cx`, CVE: `CVE-2026-73089` — Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM — fixed at `4.28.7`
  - `GHSA-73wf-gq98-2v4g`, CVE: `CVE-2026-73088` — Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) — fixed at `4.28.7`
- **Reachability / reasoning:**
  - Transitive via Babel / Vite / ESLint plugins (CONFIRMED).
  - Build-time tool for compile targets. The high DoS/cache requires untrusted `browserslist-stats.json` or many distinct queries. No reachable path from network input.

### builder-util-runtime (9.5.1)

- **Direct/transitive:** transitive
- **Parent(s):** app-builder-lib@26.8.1 / builder-util@26.8.1 / electron-builder@26.8.1 / electron-publish@26.8.1
- **Recommended bump to clear all high findings:** `9.7.0`
- **Advisories:**
  - `GHSA-p2f4-r6v6-j797`, CVE: `CVE-2026-54673` — electron-updater: Cross-origin redirect leaks `PRIVATE-TOKEN` and mixed-case `Authorization` credentials in `builder-util-runtime` — fixed at `9.7.0`
- **Reachability / reasoning:**
  - Transitive via `electron-builder` (CONFIRMED).
  - The repo does not use `electron-updater` or `autoUpdater` (CONFIRMED via grep). The cross-origin redirect credential leak only matters if auto-updates are enabled.
  - Build-only for current code.

### electron (41.2.1)

- **Direct/transitive:** DIRECT
- **Parent(s):** dev @llamactl/app@workspace / peer electron-trpc@1.0.0-alpha.0
- **Recommended bump to clear all high findings:** `41.10.3`
- **Advisories:**
  - `GHSA-v3j7-r9gq-3gjw`, CVE: `CVE-2026-70604` — Electron: Custom protocol with supportFetchAPI but not corsEnabled allows cross-origin reads — fixed at `41.4.0`
  - `GHSA-h7rp-cf8h-j98x`, CVE: `CVE-2026-70601` — Electron: Context isolation bypass via Function.prototype.bind hijack — fixed at `41.2.2`
  - `GHSA-9f4c-93c8-jc8g`, CVE: `CVE-2026-70608` — Electron: Sandboxed iframe can bypass the allow-popups restriction via the OpenURL navigation path — fixed at `41.10.3`
- **Reachability / reasoning:**
  - Direct dev/runtime dependency of `@llamactl/app` (CONFIRMED).
  - The app is an Electron app; `packages/app/electron/main.ts` creates a `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, and sets `will-navigate` and `setWindowOpenHandler({ action: "deny" })`.
  - No custom protocol is registered (CONFIRMED).
  - High advisories are runtime renderer-isolation issues; reachable but attack surface is constrained by existing isolation.

### extract-zip (2.0.1)

- **Direct/transitive:** transitive
- **Parent(s):** electron@41.2.1
- **Recommended bump to clear all high findings:** `unknown`
- **Advisories:**
  - `GHSA-jmr9-qjv8-65gv`, CVE: `CVE-2026-56876` — extract-zip unvalidated symlink path traversal — fixed at `unknown`
- **Reachability / reasoning:**
  - Transitive via `electron` (CONFIRMED).
  - Used by Electron to extract the prebuilt binary during install/build. No runtime call in source.
  - No patched version on npm (CONFIRMED via `bun pm view extract-zip versions`); fix requires an `electron` update that stops depending on `extract-zip`.

### fast-uri (3.1.0)

- **Direct/transitive:** transitive
- **Parent(s):** ajv@8.18.0
- **Recommended bump to clear all high findings:** `3.1.6`
- **Advisories:**
  - `GHSA-f65p-4m7j-42xc`, CVE: `CVE-2026-75975` — fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization — fixed at `3.1.6`
  - `GHSA-jqff-g426-hqxp`, CVE: `CVE-2026-76172` — fast-uri vulnerable to host confusion via percent-encoded scheme normalization — fixed at `3.1.6`
  - `GHSA-7p8r-x3mc-p8w7`, CVE: `CVE-2026-18446` — fast-uri vulnerable to host confusion via backslash authority introducer — fixed at `3.1.5`
  - `GHSA-v2hh-gcrm-f6hx`, CVE: `CVE-2026-16221` — fast-uri vulnerable to host confusion via literal backslash authority delimiter — fixed at `3.1.4`
  - `GHSA-q3j6-qgpj-74h6`, CVE: `CVE-2026-6321` — fast-uri vulnerable to path traversal via percent-encoded dot segments — fixed at `3.1.1`
  - `GHSA-4c8g-83qw-93j6`, CVE: `CVE-2026-13676` — fast-uri vulnerable to host confusion via failed IDN canonicalization — fixed at `3.1.3`
  - `GHSA-v39h-62p7-jpjc`, CVE: `CVE-2026-6322` — fast-uri vulnerable to host confusion via percent-encoded authority delimiters — fixed at `3.1.2`
- **Reachability / reasoning:**
  - Transitive via `ajv`, pulled in by `@modelcontextprotocol/sdk` (CONFIRMED).
  - The repo does not import `ajv` directly (CONFIRMED via grep). `ajv` is used internally by the MCP SDK to validate tool-argument schemas.
  - The MCP server uses `StdioServerTransport` (CONFIRMED), so the SSRF/host-confusion bugs would only trigger on a malicious `uri`/`uri-reference` field in a local tool call.
  - Reachable through local stdio MCP only; no OpenAI proxy/tunnel use.

### form-data (4.0.5)

- **Direct/transitive:** transitive
- **Parent(s):** @kubernetes/client-node@1.4.0 / @types/node-fetch@2.6.13 / electron-publish@26.8.1
- **Recommended bump to clear all high findings:** `4.0.6`
- **Advisories:**
  - `GHSA-hmw2-7cc7-3qxx`, CVE: `CVE-2026-12143` — form-data: CRLF injection in form-data via unescaped multipart field names and filenames — fixed at `4.0.6`
- **Reachability / reasoning:**
  - Transitive via `@kubernetes/client-node` and `electron-builder` (CONFIRMED).
  - The k8s client uses JSON bodies; no `FormData` usage found in `packages/remote` (CONFIRMED). The CRLF bug requires attacker-controlled multipart field names, not a reachable path.
  - K8s-client path is production but does not exercise `form-data`.

### hono (4.12.14)

- **Direct/transitive:** transitive
- **Parent(s):** @modelcontextprotocol/sdk@1.29.0 / peer @hono/node-server@1.19.14
- **Recommended bump to clear all high findings:** `4.12.25`
- **Advisories:**
  - `GHSA-88fw-hqm2-52qc`, CVE: `CVE-2026-54290` — hono: CORS Middleware reflects any Origin with credentials when `origin` defaults to the wildcard — fixed at `4.12.25`
- **Reachability / reasoning:**
  - Transitive via `@modelcontextprotocol/sdk` (CONFIRMED).
  - The MCP server entrypoint uses `StdioServerTransport` (CONFIRMED), so Hono's HTTP/SSE/CORS routes are not exposed.
  - No network listener uses Hono in this repo. Reachability low/inferred unless the SDK transport changes.

### ip-address (10.1.0)

- **Direct/transitive:** transitive
- **Parent(s):** express-rate-limit@8.3.2 / socks@2.8.7
- **Recommended bump to clear all high findings:** `10.3.1`
- **Advisories:**
  - `GHSA-mwp4-54f8-5fhr`, CVE: `CVE-2026-69192` — ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass — fixed at `10.3.1`
- **Reachability / reasoning:**
  - Transitive via `express-rate-limit` (MCP SDK) and `socks` (k8s client SOCKS proxy).
  - No Express server in source. `socks` is used only when a kubeconfig declares a SOCKS proxy.
  - Reachable only if an attacker controls the SOCKS proxy address in the kubeconfig, which is user-owned.

### js-yaml (4.1.1)

- **Direct/transitive:** transitive
- **Parent(s):** @eslint/eslintrc@3.3.5 / @kubernetes/client-node@1.4.0 / app-builder-lib@26.8.1 / builder-util@26.8.1 / dmg-builder@26.8.1
- **Recommended bump to clear all high findings:** `4.3.1`
- **Advisories:**
  - `GHSA-52cp-r559-cp3m`, CVE: `CVE-2026-59869` — js-yaml: YAML merge-key chains can force quadratic CPU consumption — fixed at `4.3.0`
  - `GHSA-5p4m-2wfm-xmqj` — JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported — fixed at `4.3.1`
- **Reachability / reasoning:**
  - Transitive via `@kubernetes/client-node` and `@eslint/eslintrc` (CONFIRMED).
  - The k8s client loads `~/.kube/config` via `KubeConfig.loadFromFile` (CONFIRMED). The DoS requires a crafted YAML with deep merge-key chains; kubeconfig is a user file.
  - Reachable at startup for k8s users, but input source is trusted.

### nanoid (3.3.11)

- **Direct/transitive:** transitive
- **Parent(s):** postcss@8.5.10
- **Recommended bump to clear all high findings:** `3.3.18`
- **Advisories:**
  - `GHSA-28wg-ghj8-5hjv`, CVE: `CVE-2026-67214` — nanoid: non-secure generators can loop indefinitely with negative size — fixed at `3.3.16`
  - `GHSA-2v37-7h3g-55p8`, CVE: `CVE-2026-67213` — nanoid: custom generators can loop indefinitely when size is zero — fixed at `3.3.18`
  - `GHSA-xwg4-73v4-xw9w`, CVE: `CVE-2026-73086` — nanoid: Integer Overflow or Wraparound — fixed at `3.3.12`
- **Reachability / reasoning:**
  - Transitive via `postcss` (CONFIRMED).
  - Used by PostCSS for CSS class names in the build/dev path. No attacker-controlled size/alphabet usage found.

### postcss (8.5.10)

- **Direct/transitive:** transitive
- **Parent(s):** vite@7.3.2
- **Recommended bump to clear all high findings:** `8.5.18`
- **Advisories:**
  - `GHSA-6g55-p6wh-862q`, CVE: `CVE-2026-45623` — PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments — fixed at `8.5.12`
  - `GHSA-r28c-9q8g-f849`, CVE: `CVE-2026-73646` — PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure — fixed at `8.5.18`
- **Reachability / reasoning:**
  - Transitive via `vite` (CONFIRMED).
  - The high arbitrary file read / source-map path traversal is in the PostCSS dev/build path. The Vite dev server is localhost-bound.
  - Low runtime risk; update Vite/PostCSS.

### tar (7.5.13)

- **Direct/transitive:** transitive
- **Parent(s):** @electron/rebuild@4.0.3 / app-builder-lib@26.8.1 / cacache@19.0.1 / node-gyp@11.5.0
- **Recommended bump to clear all high findings:** `7.5.21`
- **Advisories:**
  - `GHSA-8x88-c5mf-7j5w`, CVE: `CVE-2026-59874` — node-tar: Negative tar entry size causes infinite loop in archive replace — fixed at `7.5.18`
  - `GHSA-r292-9mhp-454m`, CVE: `CVE-2026-73566` — node-tar: Uncontrolled recursion in mapHas/filesFilter allows uncatchable stack-overflow DoS via crafted long-path tar with member selection — fixed at `7.5.21`
- **Reachability / reasoning:**
  - Transitive via `electron-builder` and `node-gyp` (CONFIRMED).
  - Build-only; no runtime tar extraction. Bumping `electron-builder` to a version requiring `tar` > 7.5.20.

### tmp (0.2.5)

- **Direct/transitive:** transitive
- **Parent(s):** tmp-promise@3.0.3
- **Recommended bump to clear all high findings:** `0.2.6`
- **Advisories:**
  - `GHSA-ph9p-34f9-6g65`, CVE: `CVE-2026-44705` — tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape — fixed at `0.2.6`
- **Reachability / reasoning:**
  - Transitive via `electron-builder` -> `tmp-promise` (CONFIRMED).
  - Build-only. Fixed by a patch bump, but requires an `electron-builder` update to pick it up.

### undici (7.18.0)

- **Direct/transitive:** DIRECT
- **Parent(s):** @llamactl/app@workspace
- **Recommended bump to clear all high findings:** `7.29.0`
- **Advisories:**
  - `GHSA-f269-vfmq-vjvj`, CVE: `CVE-2026-1528` — Undici: Malicious WebSocket 64-bit length overflows parser and crashes the client — fixed at `7.24.0`
  - `GHSA-vrm6-8vpv-qv8q`, CVE: `CVE-2026-1526` — Undici has Unbounded Memory Consumption in WebSocket permessage-deflate Decompression — fixed at `7.24.0`
  - `GHSA-v9p9-hfj2-hcw8`, CVE: `CVE-2026-2229` — Undici has Unhandled Exception in WebSocket Client Due to Invalid server_max_window_bits Validation — fixed at `7.24.0`
  - `GHSA-4cwx-7wf7-3272`, CVE: `CVE-2026-13697` — undici vulnerable to cross-user information disclosure and parse-time crash via degenerate private cache directives — fixed at `7.29.0`
  - `GHSA-vxpw-j846-p89q`, CVE: `CVE-2026-12151` — undici WebSocket client vulnerable to denial of service via fragment count bypass — fixed at `7.28.0`
- **Reachability / reasoning:**
  - Direct dependency of `@llamactl/app` (CONFIRMED).
  - Used in `packages/app/electron/trpc/node-pinned-fetch.ts` for the tRPC client to remote agents with a pinned-CA `undici.Agent`.
  - WebSocket-specific advisories are **not** reachable (only `fetch()`/`Agent` used). Cache/CRLF/cookie/redirect advisories affect the HTTP `fetch` path, but endpoints are pinned/self-signed and the `Agent` is per-node.
  - This is the only high package on an actual request path that carries credentials (bearer token + TLS pinning).

### vite (7.3.2)

- **Direct/transitive:** DIRECT
- **Parent(s):** dev @llamactl/app@workspace / dev llamactl (root) / peer @tailwindcss/vite / peer @vitejs/plugin-react / peer electron-vite
- **Recommended bump to clear all high findings:** `7.3.5`
- **Advisories:**
  - `GHSA-fx2h-pf6j-xcff`, CVE: `CVE-2026-53571` — vite: `server.fs.deny` bypass on Windows alternate paths — fixed at `7.3.5`
- **Reachability / reasoning:**
  - Direct dev dependency of root and `@llamactl/app` (CONFIRMED).
  - The `server.fs.deny` bypass is in the Vite dev server. The dev server is bound to localhost and only runs in development.
  - Not a production request path, but the Electron dev environment may load the Vite dev URL.

### ws (8.20.0)

- **Direct/transitive:** transitive
- **Parent(s):** @kubernetes/client-node@1.4.0 / peer isomorphic-ws@5.0.0
- **Recommended bump to clear all high findings:** `8.21.0`
- **Advisories:**
  - `GHSA-96hv-2xvq-fx4p`, CVE: `CVE-2026-48779` — ws: Memory exhaustion DoS from tiny fragments and data chunks — fixed at `8.21.0`
- **Reachability / reasoning:**
  - Transitive via `@kubernetes/client-node` (CONFIRMED).
  - The repo's tunnel uses Bun native `WebSocket` (`packages/remote/src/tunnel/*.ts` CONFIRMED); it does **not** use the `ws` package.
  - The k8s client is not used for `watch` (CONFIRMED), and no `ws` server runs. Reachability low/inferred.

## 3. OpenAI proxy, tunnel, and credential-handling flags

- **OpenAI proxy path:** `packages/remote/src/server/serve.ts` routes `/v1/*` to `openaiProxy.proxyOpenAI()` from `@llamactl/core`. `packages/core/src/openaiProxy.ts` uses `fetch()` (Bun), not `undici`, `ws`, `form-data`, `hono`, or any other audited high package. **No high-severity audited package sits directly on the OpenAI proxy path.**
- **Tunnel path:** `packages/remote/src/tunnel/*.ts` and `packages/cli/src/tunnel-dispatch.ts` use **Bun native `WebSocket`** and `Bun.serve`. The `ws` package is only a transitive dependency of `@kubernetes/client-node` and is **not used by the tunnel**.
- **Credential handling:** The only high package that touches credential-bearing network code is `undici` (`packages/app/electron/trpc/node-pinned-fetch.ts`), which wraps remote tRPC calls with pinned CAs and the bearer token. `electron` is the runtime that holds the renderer/IPC boundary where credentials could be exfiltrated if the renderer is compromised. `builder-util-runtime` would matter only if `electron-updater`/`autoUpdater` is enabled later. `form-data`/`js-yaml`/`ip-address`/`ws` are on the Kubernetes client path, which is authenticated to a cluster but the vulnerable code is not exercised by this repo.

## 4. Risk classification and recommended fix order

Sorted by reachability × severity, worst first. "Low-risk" here means the bump is a patch or minor within the same major line and the API surface used by this repo is unlikely to change. "Needs work" means the parent package must also be bumped or there is no upstream patch.

| Order | Package | Current | Bump | Direct/transitive | Reachability | Risk of bump |
|-------|---------|---------|------|-------------------|--------------|--------------|
| 1 | `undici` | 7.18.0 | `7.29.0` | direct | Reachable HTTP fetch path with credentials | Low-risk (minor; API used is `fetch`/`Agent`) |
| 2 | `electron` | 41.2.1 | `41.10.3` | direct | Runtime | Needs work (minor but many renderer changes; test app) |
| 3 | `fast-uri` | 3.1.0 | `3.1.6` | transitive (ajv/MCP SDK) | MCP schema validation, local stdio | Low-risk (patch) |
| 4 | `hono` | 4.12.14 | `4.12.34` | transitive (MCP SDK) | MCP SDK HTTP transport, not used here | Low-risk (patch) |
| 5 | `form-data` | 4.0.5 | `4.0.6` | transitive (k8s client) | K8s client path, not exercised | Low-risk (patch) |
| 6 | `ws` | 8.20.0 | `8.21.0` | transitive (k8s client) | K8s client `watch`, not used; not tunnel | Low-risk (patch) |
| 7 | `js-yaml` | 4.1.1 | `4.3.1` | transitive (k8s client + eslint) | Kubeconfig parse, user input | Low-risk (minor) |
| 8 | `ip-address` | 10.1.0 | `10.3.1` | transitive (k8s client + express-rate-limit) | SOCKS proxy / rate-limit, not used | Low-risk (minor) |
| 9 | `postcss` | 8.5.10 | `8.5.18` | transitive (vite) | Dev build CSS/source maps | Low-risk (patch) |
| 10 | `nanoid` | 3.3.11 | `3.3.18` | transitive (postcss/vite) | Dev build CSS class names | Low-risk (patch) |
| 11 | `browserslist` | 4.28.2 | `4.28.7` | transitive (babel/eslint/vite) | Build target resolution | Low-risk (patch) |
| 12 | `vite` | 7.3.2 | `7.3.5` | direct (dev) | Vite dev server, localhost | Low-risk (patch) |
| 13 | `brace-expansion` | multi | `1.1.18 / 2.1.4 / 5.0.9` | transitive (minimatch) | Build-time glob | Low-risk (patch) |
| 14 | `builder-util-runtime` | 9.5.1 | `9.7.0` | transitive (electron-builder) | Build / would matter if auto-updater enabled | Needs work (bump `electron-builder` to 26.15.0+) |
| 15 | `app-builder-lib` | 26.8.1 | `26.15.0` | transitive (electron-builder) | Build (AppImage) | Needs work (bump `electron-builder` to 26.15.0+) |
| 16 | `tar` | 7.5.13 | `7.5.21` | transitive (electron-builder/node-gyp) | Build tar extraction | Needs work (bump `electron-builder` to version using tar > 7.5.20) |
| 17 | `tmp` | 0.2.5 | `0.2.6` | transitive (electron-builder) | Build temp files | Needs work (bump `electron-builder`) |
| 18 | `extract-zip` | 2.0.1 | `none on npm` | transitive (electron) | Build (Electron prebuilt extraction) | No patch: requires upstream `electron` to switch away from `extract-zip` |

## 5. Sources and method

- `bun audit` and `bun audit --json` in the worktree (CONFIRMED).
- `bun pm why <pkg>` for each high package (CONFIRMED).
- `bun pm ls --all` to enumerate installed versions (CONFIRMED).
- `https://registry.npmjs.org/<pkg>` to find first safe version (CONFIRMED; safe versions computed with `Bun.semver`).
- `curl https://api.github.com/advisories/<GHSA>` to map high GHSA IDs to CVEs (CONFIRMED).
- Source grep for imports of `undici`, `ws`, `hono`, `js-yaml`, `ajv`, `electron-updater`, `protocol.register`, `BrowserWindow` webPreferences, `McpServer`, `StdioServerTransport`, and `watch()` in `packages/` (CONFIRMED).
- `gh` was not found on `PATH`; no GitHub Dependabot API calls were possible. This report uses `bun audit` as the fallback source, as instructed.
