// packages/app/test/console/import-guard.test.ts
// Issue #410, P5a-3a RED — pins the console import guard. Sources under
// packages/app/src/console must reach the tab's tRPC client through
// console/node-trpc.ts; importing the module-global `trpc` or
// `trpcUIClient` from lib/trpc — the "@/lib/trpc" alias or any relative
// spelling, with or without an extension, imported or re-exported — is
// a single lint error naming the replacement. The sanctioned seams
// stay clean: createAppClient inside create-node-scope.ts, the
// node-trpc.ts wrapper itself, and modules outside src/console. At the
// base commit no no-restricted-imports entry exists for console
// sources, so each "exactly one" case fails by assertion with zero
// messages — never by error.
//
// eslint.lintText/lintFiles run typed linting against
// tsconfig.eslint.json, which the probe paths are not part of, so the
// resolved no-restricted-imports entry is replayed through a bare
// flat-config Linter instead.

import { beforeAll, describe, expect, test } from "bun:test";
import { ESLint, Linter } from "eslint";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../../..");
const RULE_ID = "no-restricted-imports";
const PROBE = "packages/app/src/console/actions/stop-server.tsx";
const SCOPE_FILE = "packages/app/src/console/create-node-scope.ts";
const WRAPPER_FILE = "packages/app/src/console/node-trpc.ts";
const MODULES_FILE = "packages/app/src/lib/transport/http.ts";

const configs = new Map<string, Linter.Config>();
const linter = new Linter({ configType: "flat" });

// calculateConfigForFile builds the type-aware TS program backed by
// tsconfig.eslint.json. The e2e glob added in PR #472 grew that program
// past bun's 5 s default hook timeout on slower macOS runners, so warm
// it once here with a generous budget instead of letting the hook die
// unnamed at 5 s.
beforeAll(async () => {
  const eslint = new ESLint({ cwd: REPO });
  for (const path of [PROBE, SCOPE_FILE, WRAPPER_FILE, MODULES_FILE]) {
    const cfg = (await eslint.calculateConfigForFile(join(REPO, path))) as Linter.Config;
    configs.set(path, cfg);
  }
}, 120_000);

function ruleEntry(path: string): Linter.RuleEntry {
  return configs.get(path)?.rules?.[RULE_ID] ?? "off";
}

function lintAs(path: string, code: string): Linter.LintMessage[] {
  const entry = ruleEntry(path);
  const parser = configs.get(path)?.languageOptions?.["parser"];
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
          ...(parser ? { parser } : {}),
          sourceType: "module",
        },
        rules: { [RULE_ID]: entry },
      },
    ],
    path,
  );
  return messages.filter((message) => message.ruleId === RULE_ID);
}

const BANNED: { code: string; label: string }[] = [
  { code: 'import { trpc } from "@/lib/trpc";', label: "the @/lib/trpc alias" },
  { code: 'import { trpc } from "../lib/trpc";', label: "a one-level relative specifier" },
  { code: 'import { trpc } from "../../lib/trpc";', label: "a two-level relative specifier" },
  {
    code: 'import { trpc } from "../../lib/trpc.ts";',
    label: "a specifier with an explicit extension",
  },
  { code: 'import * as t from "@/lib/trpc";', label: "a namespace import" },
  { code: 'export { trpc } from "../lib/trpc";', label: "a re-export" },
  { code: 'import { trpcUIClient } from "@/lib/trpc";', label: "the trpcUIClient export" },
  {
    code: 'import { trpc } from "../lib/trpc-core";',
    label: "the transport-neutral trpc-core module",
  },
];

describe("console import guard (#410 P5a-3a)", () => {
  test("console sources resolve no-restricted-imports at error severity", () => {
    const entry = ruleEntry(PROBE);
    const severity = Array.isArray(entry) ? entry[0] : entry;
    expect(severity === "error" || severity === 2).toBe(true);
  });

  test.each(BANNED)(
    "importing the global proxy via $label reports exactly one error",
    ({ code }) => {
      expect(lintAs(PROBE, code)).toHaveLength(1);
    },
  );

  test("the lint message names node-trpc as the replacement", () => {
    for (const { code } of BANNED) {
      const messages = lintAs(PROBE, code);
      expect(messages[0]?.message).toContain("node-trpc");
    }
  });

  test("createAppClient stays clean inside create-node-scope.ts", () => {
    expect(lintAs(SCOPE_FILE, 'import { createAppClient } from "../lib/trpc";')).toHaveLength(0);
  });

  test("createAppClient stays clean from the transport-neutral trpc-core module", () => {
    expect(lintAs(SCOPE_FILE, 'import { createAppClient } from "../lib/trpc-core";')).toHaveLength(
      0,
    );
  });

  test("importing the node-scoped hooks stays clean", () => {
    expect(lintAs(PROBE, 'import { useNodeTrpc } from "../node-trpc";')).toHaveLength(0);
  });

  test("the sanctioned node-trpc wrapper itself stays clean", () => {
    expect(lintAs(WRAPPER_FILE, 'import { trpc } from "@/lib/trpc";')).toHaveLength(0);
  });

  test("non-console modules stay untouched by the guard", () => {
    expect(lintAs(MODULES_FILE, 'import { trpc } from "@/lib/trpc";')).toHaveLength(0);
  });
});
