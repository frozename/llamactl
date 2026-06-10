import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettierConfig from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import perfectionist from "eslint-plugin-perfectionist";
import regexp from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedFiles = ["packages/**/*.ts", "packages/**/*.tsx", "scripts/**/*.ts"];
const appRendererFiles = ["packages/app/src/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "**/coverage/**",
      "bun.lock",
      "docs/notes/**",
      "packages/train/vendor/**",
      "packages/app/release/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, Bun: "readonly" },
    },
  },
  {
    files: typedFiles,
    plugins: {
      unicorn,
      "import-x": importX,
      "unused-imports": unusedImports,
      sonarjs,
      perfectionist,
      regexp,
      security,
    },
    settings: {
      "import-x/resolver": {
        typescript: {
          project: "./tsconfig.eslint.json",
        },
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "always"],
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/only-throw-error": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-alert": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "prefer-const": "error",
      "no-var": "error",
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": "off",
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-unused-capturing-group": "error",
      "regexp/no-useless-flag": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "import-x/first": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "warn",
      "no-warning-comments": [
        "warn",
        { terms: ["todo", "fixme", "hack", "xxx"], location: "anywhere" },
      ],
      "perfectionist/sort-imports": [
        "warn",
        {
          type: "natural",
          order: "asc",
          newlinesBetween: 1,
          groups: [
            "type-import",
            ["value-builtin", "value-external"],
            ["type-internal", "value-internal"],
            ["type-parent", "type-sibling", "type-index"],
            ["value-parent", "value-sibling", "value-index"],
            "ts-equals-import",
            "unknown",
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-named-exports": ["warn", { type: "natural", order: "asc" }],
      "perfectionist/sort-exports": ["warn", { type: "natural", order: "asc" }],
      "max-lines-per-function": ["warn", { max: 120, skipBlankLines: true, skipComments: true }],
      "sonarjs/cognitive-complexity": ["warn", 12],
      "unicorn/no-for-loop": "warn",
      "unicorn/no-array-for-each": "warn",
      "unicorn/prefer-node-protocol": "warn",
      "unicorn/prefer-string-replace-all": "warn",
      "unicorn/prefer-set-has": "warn",
      "unicorn/throw-new-error": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-non-literal-regexp": "warn",
      "@typescript-eslint/prefer-readonly-parameter-types": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/member-ordering": "off",
      "perfectionist/sort-object-types": "off",
      "import-x/order": "off",
      complexity: "off",
      "sonarjs/no-duplicate-string": "off",
      "security/detect-object-injection": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
    },
  },
  {
    files: ["packages/agents/demos/**/*.ts", "tests/**/*.ts", "tools/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, Bun: "readonly" },
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["packages/mcp/src/**", "packages/**/routes/**/*.ts", "packages/**/tools/**/*.ts"],
    rules: {
      "max-lines-per-function": ["warn", { max: 250, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: appRendererFiles,
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.flat.recommended.rules,
      ...reactRefresh.configs.vite.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: [
      "packages/app/electron/**/*.ts",
      "packages/app/electron.vite.config.ts",
      "packages/app/vite.config.ts",
    ],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines-per-function": "off",
    },
  },
  prettierConfig,
);
