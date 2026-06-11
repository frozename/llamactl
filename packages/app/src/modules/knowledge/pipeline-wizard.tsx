import * as React from "react";
import { useMemo, useState } from "react";
import { stringify as stringifyYaml } from "yaml";

import { trpc } from "@/lib/trpc";

import type { FormState, SourceState, Step } from "./pipeline-types";

import { buildManifest, validate } from "./pipeline-logic";
import { emptySource, STEPS } from "./pipeline-types";
import { DestinationStep, ReviewStep, SourcesStep, TransformsStep } from "./pipeline-wizard-steps";

function WizardHeader({
  formName,
  onClose,
}: {
  formName: string;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
      <div>
        <div className="text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
          New RAG Pipeline
        </div>
        <div className="mono text-sm text-[color:var(--color-text)]">{formName || "<unnamed>"}</div>
      </div>
      <button
        type="button"
        onClick={() => {
          onClose();
        }}
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]"
      >
        Close
      </button>
    </div>
  );
}

function WizardSteps({
  currentStep,
  setStep,
}: {
  currentStep: Step;
  setStep: (s: Step) => void;
}): React.JSX.Element {
  return (
    <div className="flex gap-1 border-b border-[var(--color-border)] px-4 py-2">
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            setStep(s.id);
          }}
          className={`rounded px-2 py-1 text-xs ${s.id === currentStep ? "bg-[var(--color-brand)] text-[color:var(--color-surface-0)]" : "text-[color:var(--color-text-secondary)]"}`}
        >
          {String(i + 1)}. {s.label}
        </button>
      ))}
    </div>
  );
}

function WizardFooter({
  errors,
  currentIdx,
  step,
  setStep,
  canAdvance,
  applying,
  onApply,
}: {
  errors: string[];
  currentIdx: number;
  step: Step;
  setStep: (s: Step) => void;
  canAdvance: boolean;
  applying: boolean;
  onApply: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-3">
      <div className="text-xs">
        {errors.length > 0 && (
          <span className="text-[color:var(--color-err)]">{errors.length} issue(s) to fix</span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            const prev = STEPS[currentIdx - 1];
            if (prev) setStep(prev.id);
          }}
          disabled={currentIdx === 0}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs disabled:opacity-50"
        >
          Back
        </button>
        {step !== "review" ? (
          <button
            type="button"
            onClick={() => {
              const next = STEPS[currentIdx + 1];
              if (next) setStep(next.id);
            }}
            disabled={!canAdvance}
            className="rounded bg-[var(--color-brand)] px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={onApply}
            disabled={applying || errors.length > 0}
            className="rounded bg-[var(--color-brand)] px-3 py-1 text-xs text-white disabled:opacity-50"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        )}
      </div>
    </div>
  );
}

export function PipelineWizardModal(props: {
  open: boolean;
  onClose: () => void;
  onApplied: (name: string) => void;
  availableRagNodes: string[];
  defaultRagNode: string;
}): React.JSX.Element | null {
  const { open, onClose, onApplied, availableRagNodes, defaultRagNode } = props;
  const utils = trpc.useUtils();
  const [step, setStep] = useState<Step>("destination");
  const [form, setForm] = useState<FormState>(() => ({
    name: "",
    ragNode: defaultRagNode,
    collection: "",
    sources: [emptySource("filesystem")],
    transform: { chunk_size: 800, overlap: 150, preserve_headings: true },
    schedule: "",
    on_duplicate: "skip",
  }));
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const errors = useMemo(() => validate(form), [form]);
  const yaml = useMemo(() => {
    try {
      return stringifyYaml(buildManifest(form));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `# failed to render: ${msg}`;
    }
  }, [form]);
  const applyMut = trpc.ragPipelineApply.useMutation({
    onSuccess: async (data) => {
      setApplyError(null);
      setApplying(false);
      await utils.ragPipelineList.invalidate();
      onApplied(data.name);
    },
    onError: (err) => {
      setApplyError(err.message);
      setApplying(false);
    },
  });

  if (!open) return null;
  const currentIdx = STEPS.findIndex((s) => s.id === step);
  const canAdvance = errors.length === 0 || step !== "review";

  const updateSource = (idx: number, patch: Partial<SourceState>): void => {
    setForm((f) => ({
      ...f,
      sources: f.sources.map((s, i) => {
        if (i !== idx) return s;
        if (patch.kind && patch.kind !== s.kind) {
          return { ...emptySource(patch.kind), tag: s.tag };
        }
        return { ...s, ...patch } as SourceState;
      }),
    }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
    >
      <div className="w-full max-w-4xl rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-xl">
        <WizardHeader formName={form.name} onClose={onClose} />
        <WizardSteps currentStep={step} setStep={setStep} />
        <div className="max-h-[60vh] overflow-auto p-4">
          {step === "destination" && (
            <DestinationStep form={form} setForm={setForm} availableRagNodes={availableRagNodes} />
          )}
          {step === "sources" && (
            <SourcesStep
              sources={form.sources}
              onUpdate={updateSource}
              onRemove={(idx) => {
                setForm((f) => ({ ...f, sources: f.sources.filter((_, i) => i !== idx) }));
              }}
              onAdd={(k) => {
                setForm((f) => ({ ...f, sources: [...f.sources, emptySource(k)] }));
              }}
            />
          )}
          {step === "transforms" && (
            <TransformsStep
              transform={form.transform}
              onChange={(t) => {
                setForm((f) => ({ ...f, transform: t }));
              }}
              schedule={form.schedule}
              onScheduleChange={(v) => {
                setForm((f) => ({ ...f, schedule: v }));
              }}
              onDuplicate={form.on_duplicate}
              onOnDuplicateChange={(v) => {
                setForm((f) => ({ ...f, on_duplicate: v }));
              }}
            />
          )}
          {step === "review" && <ReviewStep yaml={yaml} errors={errors} applyError={applyError} />}
        </div>
        <WizardFooter
          applying={applying}
          canAdvance={canAdvance}
          currentIdx={currentIdx}
          errors={errors}
          onApply={() => {
            setApplying(true);
            applyMut.mutate({ manifestYaml: yaml });
          }}
          setStep={setStep}
          step={step}
        />
      </div>
    </div>
  );
}
