import * as React from "react";

import { Button, Input } from "@/ui";

import type { ClassFilter, Preset, Profile } from "./types";
import type { UsePresetsReturn } from "./use-presets";

import { PRESETS, PROFILES } from "./types";
import { fmtTps } from "./utils";

export interface CandidateRowData {
  rel: string;
  class: string;
  installed: boolean;
  tuned?: {
    gen_tps?: string;
    prompt_tps?: string;
  };
}

interface PromotionRow {
  profile: Profile;
  preset: Preset;
  rel: string;
}

export function PromotionsMatrix({
  presetsObj,
}: {
  presetsObj: UsePresetsReturn;
}): React.JSX.Element {
  const { promotions, tpsByRel, deleteMutation } = presetsObj;
  const rows = (promotions.data ?? []) as PromotionRow[];

  return (
    <section style={{ marginBottom: 24 }}>
      <h2
        style={{
          marginBottom: 8,
          fontSize: 14,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Current promotions
      </h2>
      <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
        <table style={{ width: "100%", fontFamily: "monospace", fontSize: 14 }}>
          <thead
            style={{
              backgroundColor: "var(--color-surface-1)",
              textAlign: "left",
              color: "var(--color-text-secondary)",
            }}
          >
            <tr>
              <th style={{ padding: "8px 12px", fontWeight: 500 }}>Profile</th>
              {PRESETS.map((p) => (
                <th key={p} style={{ padding: "8px 12px", fontWeight: 500 }}>
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROFILES.map((profile) => (
              <tr
                key={profile}
                style={{
                  borderTop: "1px solid var(--color-border)",
                  backgroundColor: "var(--color-surface-1)",
                }}
              >
                <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                  {profile}
                </td>
                {PRESETS.map((preset) => {
                  const row = rows.find((o) => o.profile === profile && o.preset === preset);
                  if (!row) {
                    return (
                      <td
                        key={preset}
                        style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}
                      >
                        —
                      </td>
                    );
                  }
                  const tps = tpsByRel.get(row.rel);
                  return (
                    <td key={preset} style={{ padding: "8px 12px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ color: "var(--color-brand)", wordBreak: "break-all" }}>
                          {row.rel}
                        </span>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontSize: 10,
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          {tps !== undefined ? (
                            <span>{tps.toFixed(1)} tok/s</span>
                          ) : (
                            <span>no bench</span>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void (async (): Promise<void> => {
                                try {
                                  await deleteMutation.mutateAsync({ profile, preset });
                                } catch (err) {
                                  console.error("delete failed:", (err as Error).message);
                                }
                              })();
                            }}
                            disabled={deleteMutation.isPending}
                            style={{ fontSize: 10, padding: "2px 4px" }}
                            title={`remove promotion for ${profile}/${preset}`}
                          >
                            ×
                          </Button>
                        </div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CandidateFilters({
  presetsObj,
}: {
  presetsObj: UsePresetsReturn;
}): React.JSX.Element {
  const {
    candidates,
    minTps,
    setMinTps,
    installedOnly,
    setInstalledOnly,
    classFilter,
    setClassFilter,
  } = presetsObj;
  return (
    <div
      style={{
        marginBottom: 8,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Candidates ({candidates.length})
      </h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          fontSize: 12,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: "var(--color-text-secondary)",
          }}
        >
          min tok/s
          <Input
            type="number"
            min={0}
            step={5}
            value={minTps}
            onChange={(e) => {
              setMinTps(Math.max(0, Number.parseFloat(e.target.value) || 0));
            }}
            data-testid="presets-min-tps"
            style={{ width: 64, textAlign: "right", fontFamily: "monospace" }}
          />
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: "var(--color-text-secondary)",
          }}
        >
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={(e) => {
              setInstalledOnly(e.target.checked);
            }}
            data-testid="presets-installed-only"
          />
          installed only
        </label>
        <span style={{ color: "var(--color-text-secondary)" }}>class</span>
        <select
          value={classFilter}
          onChange={(e) => {
            setClassFilter(e.target.value as ClassFilter);
          }}
          style={{
            borderRadius: 4,
            border: "1px solid var(--color-border)",
            backgroundColor: "var(--color-surface-2)",
            padding: "4px 8px",
            fontFamily: "monospace",
            fontSize: 11,
            color: "var(--color-text)",
          }}
        >
          <option value="all">all</option>
          <option value="reasoning">reasoning</option>
          <option value="multimodal">multimodal</option>
          <option value="general">general</option>
          <option value="custom">custom</option>
        </select>
      </div>
    </div>
  );
}

export function CandidateTable({
  presetsObj,
}: {
  presetsObj: UsePresetsReturn;
}): React.JSX.Element {
  const { candidates, bench, classFilter } = presetsObj;
  return (
    <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
      <table style={{ width: "100%", fontFamily: "monospace", fontSize: 14 }}>
        <thead
          style={{
            backgroundColor: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Rel</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Class</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Installed</th>
            <th style={{ padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>gen tok/s</th>
            <th style={{ padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>
              prompt tok/s
            </th>
            <th style={{ width: 80, padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>
              Start
            </th>
            <th style={{ width: 288, padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>
              Promote
            </th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((row: CandidateRowData) => (
            <CandidateRow key={row.rel} row={row} presetsObj={presetsObj} />
          ))}
          {bench.isSuccess && candidates.length === 0 && (
            <tr>
              <td
                colSpan={7}
                style={{
                  padding: "24px 12px",
                  textAlign: "center",
                  color: "var(--color-text-secondary)",
                }}
              >
                No candidates for class &quot;{classFilter}&quot;.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CandidateRow({
  row,
  presetsObj,
}: {
  row: CandidateRowData;
  presetsObj: UsePresetsReturn;
}): React.JSX.Element {
  const { pendingRel, copyStartCommand, copiedRel, setPendingRel, setError } = presetsObj;
  const isPending = pendingRel === row.rel;
  const gen = fmtTps(row.tuned?.gen_tps);
  const pt = fmtTps(row.tuned?.prompt_tps);

  return (
    <tr
      style={{
        borderTop: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
      }}
    >
      <td
        style={{
          padding: "8px 12px",
          color: "var(--color-brand)",
          wordBreak: "break-all",
        }}
      >
        {row.rel}
      </td>
      <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>{row.class}</td>
      <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
        {row.installed ? "yes" : "no"}
      </td>
      <td style={{ padding: "8px 12px", textAlign: "right" }}>{gen}</td>
      <td
        style={{
          padding: "8px 12px",
          textAlign: "right",
          color: "var(--color-text-secondary)",
        }}
      >
        {pt}
      </td>
      <td style={{ padding: "8px 12px", textAlign: "right" }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void copyStartCommand(row.rel);
          }}
          data-testid={`presets-start-${row.rel}`}
          title={`Copy: llamactl server start '${row.rel}'`}
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          {copiedRel === row.rel ? "copied" : "start"}
        </Button>
      </td>
      <td style={{ padding: "8px 12px", textAlign: "right" }}>
        {isPending ? (
          <PromoteControls rel={row.rel} presetsObj={presetsObj} />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingRel(row.rel);
              setError(null);
            }}
          >
            Promote to…
          </Button>
        )}
      </td>
    </tr>
  );
}

function PromoteControls({
  rel,
  presetsObj,
}: {
  rel: string;
  presetsObj: UsePresetsReturn;
}): React.JSX.Element {
  const { pickProfile, setPickProfile, pickPreset, setPickPreset, promoteMutation, setPendingRel } =
    presetsObj;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
      }}
    >
      <select
        value={pickProfile}
        onChange={(e) => {
          setPickProfile(e.target.value as Profile);
        }}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-2)",
          padding: "2px 4px",
          fontFamily: "monospace",
        }}
      >
        {PROFILES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        value={pickPreset}
        onChange={(e) => {
          setPickPreset(e.target.value as Preset);
        }}
        style={{
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-2)",
          padding: "2px 4px",
          fontFamily: "monospace",
        }}
      >
        {PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <Button
        variant="primary"
        size="sm"
        disabled={promoteMutation.isPending}
        onClick={() => {
          void (async (): Promise<void> => {
            try {
              await promoteMutation.mutateAsync({
                profile: pickProfile,
                preset: pickPreset,
                rel,
              });
            } catch (err) {
              console.error("promote failed:", (err as Error).message);
            }
          })();
        }}
        style={{ padding: "2px 8px" }}
      >
        {promoteMutation.isPending ? "Setting…" : "Set"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setPendingRel(null);
        }}
        style={{ padding: "2px 8px" }}
      >
        Cancel
      </Button>
    </span>
  );
}
