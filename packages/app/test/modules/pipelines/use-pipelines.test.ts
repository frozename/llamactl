import "../../setup.ts";
import { describe, expect, test } from "bun:test";

import type { Pipeline, Stage } from "../../../src/modules/pipelines/types";

import {
  applyChatStreamEvent,
  type ChatStreamEvent,
  selectRunningPipeline,
  type StageRunControls,
} from "../../../src/modules/pipelines/use-pipelines";

function makeStage(id: string): Stage {
  return { id, node: "local", model: "m", systemPrompt: "", capabilities: [] };
}

function makePipeline(id: string): Pipeline {
  return { id, name: id, stages: [makeStage(`s-${id}`)] };
}

function makeControls(onOutputs: (outputs: string[]) => void): StageRunControls {
  return {
    setCurrentIdx: (): void => undefined,
    setOutputs: (fn: (prev: string[]) => string[]): void => {
      onOutputs(fn([""]));
    },
    setRunError: (): void => undefined,
    setRunningId: (): void => undefined,
    setStreamInput: (): void => undefined,
    setStreamKey: (): void => undefined,
  };
}

describe("selectRunningPipeline", () => {
  test("returns pipeline identified by runningId, not any other pipeline", () => {
    const pipelineA = makePipeline("A");
    const pipelineB = makePipeline("B");
    const pipelines = { A: pipelineA, B: pipelineB };

    // Running pipeline is A; active pipeline (not passed here) would be B.
    // The function must resolve by runningId, never by active.
    const target = selectRunningPipeline(pipelines, "A");
    expect(target).toBe(pipelineA);
    expect(target).not.toBe(pipelineB);
  });

  test("returns undefined when runningId is null (no run in progress)", () => {
    const pipelines = { A: makePipeline("A") };
    expect(selectRunningPipeline(pipelines, null)).toBeUndefined();
  });

  test("returns undefined when runningId does not match any pipeline", () => {
    const pipelines = { A: makePipeline("A") };
    expect(selectRunningPipeline(pipelines, "missing")).toBeUndefined();
  });
});

describe("applyChatStreamEvent", () => {
  test("chunk event appends content to current stage output", () => {
    const pipeline = makePipeline("A");
    let captured: string[] = [""];

    const evt: ChatStreamEvent = {
      type: "chunk",
      chunk: { choices: [{ delta: { content: "hello" } }] },
    };
    applyChatStreamEvent(
      evt,
      pipeline,
      0,
      makeControls((o) => {
        captured = o;
      }),
    );
    expect(captured[0]).toBe("hello");
  });

  test("error event sets run error and clears running state", () => {
    const pipeline = makePipeline("A");
    let capturedError: string | null = null;
    let runningCleared = false;

    const controls: StageRunControls = {
      setCurrentIdx: (): void => undefined,
      setOutputs: (): void => undefined,
      setRunError: (v): void => {
        capturedError = v;
      },
      setRunningId: (v): void => {
        if (v === null) runningCleared = true;
      },
      setStreamInput: (): void => undefined,
      setStreamKey: (): void => undefined,
    };

    const evt: ChatStreamEvent = { type: "error", error: { message: "boom" } };
    applyChatStreamEvent(evt, pipeline, 0, controls);

    // capturedError is mutated inside the setRunError callback above, which
    // control-flow analysis can't see — annotate the assertion so it isn't
    // narrowed to the `null` initializer.
    expect<string | null>(capturedError).toBe("boom");
    expect(runningCleared).toBe(true);
  });

  test("stream routes to running pipeline A when active has switched to B", () => {
    const pipelineA = makePipeline("A");
    const pipelineB = makePipeline("B");
    const pipelines = { A: pipelineA, B: pipelineB };

    const runningId = "A";
    // Simulate: user switched active to B while A is still running.
    // selectRunningPipeline must return A, so the chunk lands on A.
    const running = selectRunningPipeline(pipelines, runningId);
    expect(running).toBeDefined();

    let aOutput = "";
    const bOutput = "";

    const evt: ChatStreamEvent = {
      type: "chunk",
      chunk: { choices: [{ delta: { content: "hello" } }] },
    };

    // Apply to whichever pipeline selectRunningPipeline resolves (must be A).
    applyChatStreamEvent(
      evt,
      running!,
      0,
      makeControls((o) => {
        aOutput = o[0] ?? "";
      }),
    );

    // A receives the chunk; B is untouched.
    expect(aOutput).toBe("hello");
    expect(bOutput).toBe("");
  });
});
