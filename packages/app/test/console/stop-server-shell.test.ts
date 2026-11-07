// packages/app/test/console/stop-server-shell.test.ts
// Issue #410 P5a-3a review — pins the stop-server shell's own wiring,
// not just the pure decisions stop-dialog.test.ts covers. Through a
// react-dom/server render inside NodeScopedProvider (fake node-scoped
// tRPC client, `@/ui` stand-ins that capture their props) the Stop
// button must render disabled before an exact typed match; the submit
// path driven by the captured handlers must invalidate exactly
// serverStatus and workloadList, toast only on {stopped: true}, and
// close only on success. mock.module is process-global in bun, so the
// real modules are snapshotted before stubbing and re-registered in
// afterAll; the whole test/console dir must stay green behind this file.

import type { ChangeEvent, ReactElement, ReactNode } from "react";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConsoleWorkloadRow } from "../../src/console/workloads-scope";

const NODE_TRPC_SPEC = "../../src/console/node-trpc.ts";
const CONSOLE_NODE = "local";
const WORKLOAD = "qwen";

const uiReal = { ...(await import("../../src/ui/index")) };
const nodeTrpcReal = { ...(await import("../../src/console/node-trpc.ts")) };

interface StopCallStub {
  graceSeconds: number;
  workload: string;
}

interface StopResultStub {
  killed: boolean;
  pid: number | null;
  stopped: boolean;
}

interface StubButtonProps {
  children?: ReactNode;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
  size?: string | undefined;
  variant?: string | undefined;
}

interface StubInputProps {
  "aria-labelledby"?: string | undefined;
  onChange?: ((event: ChangeEvent<HTMLInputElement>) => void) | undefined;
  value?: string | undefined;
}

interface InvalidateStub {
  invalidate: () => Promise<void>;
}

interface MutationStub {
  isPending: boolean;
  mutateAsync: (input: StopCallStub) => Promise<StopResultStub>;
}

const renderedButtons: StubButtonProps[] = [];
const renderedInputs: StubInputProps[] = [];
const mutateCalls: StopCallStub[] = [];
const invalidatedKeys: string[] = [];
const toastTexts: string[] = [];
let closeCount = 0;
let scenario: "error" | "refusal" | "success" = "success";

function mutateAsync(input: StopCallStub): Promise<StopResultStub> {
  mutateCalls.push(input);
  if (scenario === "success") {
    return Promise.resolve({ killed: false, pid: 42, stopped: true });
  }
  if (scenario === "refusal") {
    return Promise.resolve({ killed: false, pid: 4242, stopped: false });
  }
  return Promise.reject(new Error("boom"));
}

const trpcStub = {
  serverStop: {
    useMutation: (_options: unknown): MutationStub => ({
      isPending: false,
      mutateAsync,
    }),
  },
};

const utilsStub = new Proxy<Record<string, InvalidateStub>>(
  {},
  {
    get: (_target, key): InvalidateStub => {
      const named = typeof key === "string" ? key : "<non-string>";
      return {
        invalidate: (): Promise<void> => {
          invalidatedKeys.push(named);
          return Promise.resolve();
        },
      };
    },
  },
);

function ButtonStub(props: StubButtonProps): ReactElement {
  renderedButtons.push(props);
  return createElement(
    "button",
    { disabled: props.disabled ?? false, onClick: props.onClick, type: "button" },
    props.children,
  );
}

function InputStub(props: StubInputProps): ReactElement {
  renderedInputs.push(props);
  return createElement("input", { readOnly: true, value: props.value ?? "" });
}

void mock.module("@/ui", () => ({ ...uiReal, Button: ButtonStub, Input: InputStub }));
void mock.module(NODE_TRPC_SPEC, () => ({
  ...nodeTrpcReal,
  useConsoleNode: (): string => CONSOLE_NODE,
  useNodeTrpc: (): unknown => trpcStub,
  useNodeTrpcUtils: (): unknown => utilsStub,
}));

const { NodeScopedProvider } = await import("../../src/console/node-scoped-provider.tsx");
const { StopServerDialog } = await import("../../src/console/actions/stop-server.tsx");

afterAll(() => {
  void mock.module("@/ui", () => uiReal);
  void mock.module(NODE_TRPC_SPEC, () => nodeTrpcReal);
});

function makeRow(): ConsoleWorkloadRow {
  return {
    endpoint: "http://127.0.0.1:8080",
    kind: "ModelRun",
    name: WORKLOAD,
    node: CONSOLE_NODE,
    workerNodes: [],
  };
}

function onSuccessToast(text: string): void {
  toastTexts.push(text);
}

function onClose(): void {
  closeCount += 1;
}

function renderDialog(): string {
  renderedButtons.length = 0;
  renderedInputs.length = 0;
  return renderToStaticMarkup(
    createElement(
      NodeScopedProvider,
      { node: CONSOLE_NODE },
      createElement(StopServerDialog, {
        node: CONSOLE_NODE,
        onClose,
        onSuccessToast,
        row: makeRow(),
      }),
    ),
  );
}

function buttonPropsFor(label: string): StubButtonProps {
  const button = renderedButtons.findLast((candidate) => candidate.children === label);
  if (!button) throw new Error(`missing ${label} button`);
  return button;
}

function typeIntoConfirm(value: string): void {
  const input = renderedInputs.at(-1);
  if (!input?.onChange) throw new Error("missing confirm input");
  input.onChange({ target: { value } } as unknown as ChangeEvent<HTMLInputElement>);
}

function clickButton(label: string): void {
  const button = buttonPropsFor(label);
  if (!button.onClick) throw new Error(`missing ${label} click handler`);
  button.onClick();
}

async function flushSubmitChain(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("stop-server dialog shell (#410 P5a-3a review)", () => {
  beforeEach(() => {
    scenario = "success";
    mutateCalls.length = 0;
    invalidatedKeys.length = 0;
    toastTexts.length = 0;
    closeCount = 0;
  });

  test("renders through NodeScopedProvider with the Stop button disabled before an exact typed match", () => {
    const markup = renderDialog();

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain(`Type ${WORKLOAD} to confirm`);
    expect(markup).toContain("disabled");
    expect(buttonPropsFor("Stop").disabled).toBe(true);
    expect(buttonPropsFor("Cancel").disabled).toBeUndefined();
    expect(renderedInputs.at(-1)?.value).toBe("");
  });

  test("a mistyped confirmation submits nothing through the node-scoped client", async () => {
    renderDialog();
    typeIntoConfirm("qwe");
    clickButton("Stop");
    await flushSubmitChain();

    expect(mutateCalls).toEqual([]);
    expect(invalidatedKeys).toEqual([]);
    expect(toastTexts).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test("an exact typed match invalidates exactly serverStatus and workloadList", async () => {
    renderDialog();
    typeIntoConfirm(WORKLOAD);
    clickButton("Stop");
    await flushSubmitChain();

    expect(mutateCalls).toEqual([{ graceSeconds: 5, workload: WORKLOAD }]);
    expect(invalidatedKeys).toEqual(["serverStatus", "workloadList"]);
  });

  test("a confirmed stop toasts the success text once and closes", async () => {
    renderDialog();
    typeIntoConfirm(WORKLOAD);
    clickButton("Stop");
    await flushSubmitChain();

    expect(toastTexts).toHaveLength(1);
    expect(toastTexts[0]).toContain("Stopped llama-server (PID 42)");
    expect(closeCount).toBe(1);
  });

  test("an unconfirmed stop invalidates both queries without a toast or a close", async () => {
    scenario = "refusal";
    renderDialog();
    typeIntoConfirm(WORKLOAD);
    clickButton("Stop");
    await flushSubmitChain();

    expect(invalidatedKeys).toEqual(["serverStatus", "workloadList"]);
    expect(toastTexts).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test("a transport error neither invalidates, toasts, nor closes", async () => {
    scenario = "error";
    renderDialog();
    typeIntoConfirm(WORKLOAD);
    clickButton("Stop");
    await flushSubmitChain();

    expect(mutateCalls).toEqual([{ graceSeconds: 5, workload: WORKLOAD }]);
    expect(invalidatedKeys).toEqual([]);
    expect(toastTexts).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test("Cancel closes the dialog without touching the node-scoped client", () => {
    renderDialog();
    clickButton("Cancel");

    expect(closeCount).toBe(1);
    expect(mutateCalls).toEqual([]);
    expect(invalidatedKeys).toEqual([]);
  });
});
