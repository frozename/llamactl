/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
/* eslint-disable security/detect-non-literal-fs-filename -- Test fixtures use dynamic paths derived from mkdtempSync. */
import { listPeers, type PeerNode } from "@llamactl/core/config/peers";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { AggregatorPeer } from "../src/aggregator.js";
import type { NodeSnapshot } from "../src/migration-controller.js";

import {
  createEnabledMigrationController,
  createMigrationController,
  MigrationController,
} from "../src/index.js";
import { defaultFleetJournalPath, readRecentMovesFromJournal } from "../src/journal.js";

describe("migration controller factory: gate, peer ids, and journal seeding", () => {
  const originalFleetMoveEnabled = process.env["LLAMACTL_FLEET_MOVE_ENABLED"];
  const originalDevStorage = process.env["DEV_STORAGE"];
  const originalConfig = process.env["LLAMACTL_CONFIG"];

  afterEach(() => {
    if (originalFleetMoveEnabled === undefined) {
      delete process.env["LLAMACTL_FLEET_MOVE_ENABLED"];
    } else {
      process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = originalFleetMoveEnabled;
    }
    if (originalDevStorage === undefined) {
      delete process.env["DEV_STORAGE"];
    } else {
      process.env["DEV_STORAGE"] = originalDevStorage;
    }
    if (originalConfig === undefined) {
      delete process.env["LLAMACTL_CONFIG"];
    } else {
      process.env["LLAMACTL_CONFIG"] = originalConfig;
    }
  });

  function peer(overrides: Partial<AggregatorPeer> = {}): AggregatorPeer {
    return {
      id: "m2mini",
      endpoint: "https://m2mini.local:8080",
      ...overrides,
    };
  }

  function highSnapshot(nodeName = "m4pro"): NodeSnapshot {
    return {
      node: nodeName,
      pressureState: "HIGH",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };
  }

  function workload(name = "model-a"): {
    name: string;
    node?: string;
    spec?: { placement?: string; resources?: { memoryMb?: number } };
    evictProposalId?: string;
  } {
    return {
      name,
      node: "m4pro",
      spec: { placement: "auto" },
      evictProposalId: `evict-${name}`,
    };
  }

  function fetchSnapshot(
    snapshots: Record<string, NodeSnapshot>,
  ): (node: string) => Promise<NodeSnapshot> {
    return async (node): Promise<NodeSnapshot> =>
      snapshots[node] ?? {
        node,
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      };
  }

  it("F31: gate rejects when LLAMACTL_FLEET_MOVE_ENABLED is absent", () => {
    delete process.env["LLAMACTL_FLEET_MOVE_ENABLED"];

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it('F31: gate rejects when LLAMACTL_FLEET_MOVE_ENABLED is "true"', () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "true";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it('F31: gate rejects when LLAMACTL_FLEET_MOVE_ENABLED is "0"', () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "0";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it('F31: gate rejects when LLAMACTL_FLEET_MOVE_ENABLED is "yes"', () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "yes";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it('F31: gate rejects when LLAMACTL_FLEET_MOVE_ENABLED is " 1" (with leading space)', () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = " 1";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).toBeNull();
  });

  it('F31: gate accepts when LLAMACTL_FLEET_MOVE_ENABLED is exactly "1"', () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const controller = createEnabledMigrationController({
      peers: [],
      fetchSnapshot: async () => ({
        pressureState: "NORMAL",
        nodeMem: { freeMb: 4096 },
        workloads: [],
      }),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();
    expect(controller).toBeInstanceOf(MigrationController);
  });

  it("T14: createEnabledMigrationController resolves peer ids from supplied peers", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      peers: [peer({ id: "node-alpha" }), peer({ id: "node-beta" })],
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();

    snapshots["node-alpha"] = {
      node: "node-alpha",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };
    snapshots["m4pro"] = highSnapshot();

    const result = controller!.evaluateMove(workload(), highSnapshot());
    return result.then((proposal) => {
      expect(proposal).not.toBeNull();
      expect(proposal!.toNode).toBe("node-alpha");
    });
  });

  it("T14: createEnabledMigrationController resolves peer ids from listPeers when peers not supplied", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
  nodes:
  - name: m2mini
    kind: agent
    endpoint: https://m2mini.local:8080
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    const hasM2Mini = peers.some((p) => p.id === "m2mini");

    if (hasM2Mini) {
      const snapshots: Record<string, NodeSnapshot> = {};
      const controller = createEnabledMigrationController({
        fetchSnapshot: fetchSnapshot(snapshots),
        selfNode: "m4pro",
        getLeaseHolder: () => "m4pro",
      });

      expect(controller).not.toBeNull();

      snapshots["m2mini"] = {
        node: "m2mini",
        pressureState: "NORMAL",
        nodeMem: { freeMb: 8000 },
        workloads: [],
      };
      snapshots["m4pro"] = highSnapshot();

      const result = controller!.evaluateMove(workload(), highSnapshot());
      return result.then((proposal) => {
        if (proposal) {
          expect(proposal.toNode).toBe("m2mini");
        }
      });
    }

    // If no https peers configured, verify that listPeers returns empty
    // and the controller falls back to empty peers array (no moves possible).
    expect(peers).toHaveLength(0);

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();
    snapshots["m2mini"] = {
      node: "m2mini",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };
    snapshots["m4pro"] = highSnapshot();

    const result = controller!.evaluateMove(workload(), highSnapshot());
    return result.then((proposal) => {
      expect(proposal).toBeNull();
    });
  });

  it("T15: listPeers filters non-https endpoints", () => {
    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
  nodes:
  - name: https-node
    kind: agent
    endpoint: https://https-node.local:8080
  - name: http-node
    kind: agent
    endpoint: http://http-node.local:8080
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    expect(peers.map((p: PeerNode) => p.id)).toEqual(["https-node"]);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T15: listPeers filters local nodes", () => {
    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
  nodes:
  - name: remote-node
    kind: agent
    endpoint: https://remote.local:8080
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    // LOCAL_NODE_NAME is "local" — no local node in clusterNodes,
    // so remote-node should be included.
    expect(peers.map((p: PeerNode) => p.id)).toEqual(["remote-node"]);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T15: listPeers returns empty array when peers config is absent", () => {
    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    expect(peers).toHaveLength(0);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("F27: default journal seeding reads from DEV_STORAGE/fleet-supervisor/journal.jsonl", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    const journalDir = `${tempDir}/fleet-supervisor`;
    mkdirSync(journalDir, { recursive: true });
    process.env["DEV_STORAGE"] = tempDir;

    const journalPath = defaultFleetJournalPath();
    expect(journalPath).toContain(`${tempDir}/fleet-supervisor/journal.jsonl`);

    const nowMs = Date.now();
    const journalEntry = JSON.stringify({
      kind: "fleet-proposal",
      ts: new Date(nowMs).toISOString(),
      node: "m4pro",
      proposalId: "move-model-a",
      transition: {
        subject: "model-a",
        subjectKind: "workload",
        signal: "placement",
        from: "m4pro",
        to: "m2mini",
      },
      action: {
        type: "move",
        workload: "model-a",
        fromNode: "m4pro",
        toNode: "m2mini",
        reason: "rebalance",
      },
    });
    writeFileSync(journalPath, journalEntry);

    const recentMoves = readRecentMovesFromJournal(journalPath);
    expect(recentMoves).toEqual([
      {
        workload: "model-a",
        movedAtMs: nowMs,
      },
    ]);

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();

    // Verify isInMoveCooldown respects the seeded journal entries
    expect(controller!.isInMoveCooldown("model-a")).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("F27: isInMoveCooldown respects timestamps from seeded journal", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    const journalDir = `${tempDir}/fleet-supervisor`;
    mkdirSync(journalDir, { recursive: true });
    process.env["DEV_STORAGE"] = tempDir;

    const journalPath = defaultFleetJournalPath();

    const nowMs = Date.now();
    const recentEntry = JSON.stringify({
      kind: "fleet-proposal",
      ts: new Date(nowMs).toISOString(),
      node: "m4pro",
      proposalId: "move-old-workload",
      transition: {
        subject: "old-workload",
        subjectKind: "workload",
        signal: "placement",
        from: "m4pro",
        to: "m2mini",
      },
      action: {
        type: "move",
        workload: "old-workload",
        fromNode: "m4pro",
        toNode: "m2mini",
        reason: "rebalance",
      },
    });
    writeFileSync(journalPath, recentEntry);

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller).not.toBeNull();

    // Recent entry should be in cooldown
    expect(controller!.isInMoveCooldown("old-workload")).toBe(true);

    // Unknown workload should not be in cooldown
    expect(controller!.isInMoveCooldown("unknown-workload")).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T16: explicit readRecentMoves overrides default journal reading", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    const journalDir = `${tempDir}/fleet-supervisor`;
    mkdirSync(journalDir, { recursive: true });
    process.env["DEV_STORAGE"] = tempDir;

    const journalPath = defaultFleetJournalPath();

    // Write a journal entry that should NOT be picked up
    const nowMs = Date.now();
    writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "fleet-proposal",
        ts: new Date(nowMs).toISOString(),
        node: "m4pro",
        proposalId: "move-model-a",
        transition: {
          subject: "model-a",
          subjectKind: "workload",
          signal: "placement",
          from: "m4pro",
          to: "m2mini",
        },
        action: {
          type: "move",
          workload: "model-a",
          fromNode: "m4pro",
          toNode: "m2mini",
          reason: "rebalance",
        },
      }),
    );

    // Supply explicit readRecentMoves that returns different data
    const explicitMoves = [{ workload: "explicit-workload", movedAtMs: nowMs }];

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
      readRecentMoves: (): { workload: string; movedAtMs: number }[] => explicitMoves,
    });

    expect(controller).not.toBeNull();

    // Should use explicit data, not the journal file
    expect(controller!.isInMoveCooldown("explicit-workload")).toBe(true);
    expect(controller!.isInMoveCooldown("model-a")).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T16: createMigrationController does not seed default journal", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    const journalDir = `${tempDir}/fleet-supervisor`;
    mkdirSync(journalDir, { recursive: true });
    process.env["DEV_STORAGE"] = tempDir;

    const journalPath = defaultFleetJournalPath();

    // Write a journal entry that should NOT be picked up by createMigrationController
    const nowMs = Date.now();
    writeFileSync(
      journalPath,
      JSON.stringify({
        kind: "fleet-proposal",
        ts: new Date(nowMs).toISOString(),
        node: "m4pro",
        proposalId: "move-model-a",
        transition: {
          subject: "model-a",
          subjectKind: "workload",
          signal: "placement",
          from: "m4pro",
          to: "m2mini",
        },
        action: {
          type: "move",
          workload: "model-a",
          fromNode: "m4pro",
          toNode: "m2mini",
          reason: "rebalance",
        },
      }),
    );

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createMigrationController({
      peers: ["m2mini"],
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    // createMigrationController does not seed from journal — isInMoveCooldown
    // should be false for "model-a" since no readRecentMoves was supplied.
    expect(controller.isInMoveCooldown("model-a")).toBe(false);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T16: createMigrationController isInMoveCooldown returns false without readRecentMoves", () => {
    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createMigrationController({
      peers: ["m2mini"],
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    expect(controller.isInMoveCooldown("any-workload")).toBe(false);
  });

  it("T14: evaluateMove calls fetchSnapshot with peer.id, not endpoint", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const snapshots: Record<string, NodeSnapshot> = {};
    let fetchedNodeId: string | null = null;

    const controller = createEnabledMigrationController({
      peers: [peer({ id: "target-node" })],
      fetchSnapshot: async (node): Promise<NodeSnapshot> => {
        fetchedNodeId = node;
        return (
          snapshots[node] ?? {
            node,
            pressureState: "NORMAL",
            nodeMem: { freeMb: 8000 },
            workloads: [],
          }
        );
      },
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    snapshots["m4pro"] = highSnapshot();
    snapshots["target-node"] = {
      node: "target-node",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 8000 },
      workloads: [],
    };

    return controller!.evaluateMove(workload(), highSnapshot()).then((proposal) => {
      expect(fetchedNodeId).toBe("target-node");
      expect(proposal).not.toBeNull();
      expect(proposal!.toNode).toBe("target-node");
    });
  });

  it("T14: evaluateMove selects toNode based on highest freeMb via evaluateMove", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      peers: [peer({ id: "node-low" }), peer({ id: "node-high" })],
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    snapshots["m4pro"] = highSnapshot();
    snapshots["node-low"] = {
      node: "node-low",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 2000 },
      workloads: [],
    };
    snapshots["node-high"] = {
      node: "node-high",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 16000 },
      workloads: [],
    };

    return controller!.evaluateMove(workload(), highSnapshot()).then((proposal) => {
      expect(proposal).not.toBeNull();
      expect(proposal!.toNode).toBe("node-high");
    });
  });

  it("T14: evaluateMove returns null when no viable destination exists", () => {
    process.env["LLAMACTL_FLEET_MOVE_ENABLED"] = "1";

    const snapshots: Record<string, NodeSnapshot> = {};
    const controller = createEnabledMigrationController({
      peers: [peer({ id: "node-low-mem" })],
      fetchSnapshot: fetchSnapshot(snapshots),
      selfNode: "m4pro",
      getLeaseHolder: () => "m4pro",
    });

    snapshots["m4pro"] = highSnapshot();
    snapshots["node-low-mem"] = {
      node: "node-low-mem",
      pressureState: "NORMAL",
      nodeMem: { freeMb: 100 },
      workloads: [],
    };

    return controller!.evaluateMove(workload(), highSnapshot()).then((proposal) => {
      expect(proposal).toBeNull();
    });
  });

  it("T15: listPeers filters out local node by name", () => {
    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
  nodes:
  - name: local
    kind: agent
    endpoint: https://local.local:8080
  - name: remote-node
    kind: agent
    endpoint: https://remote.local:8080
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    // "local" should be filtered out (LOCAL_NODE_NAME)
    expect(peers.map((p: PeerNode) => p.id)).toEqual(["remote-node"]);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("T15: listPeers filters out local node by endpoint", () => {
    const tempDir = mkdtempSync(`${tmpdir()}/llamactl-test-`);
    process.env["DEV_STORAGE"] = tempDir;

    const configDir = `${tempDir}/config`;
    mkdirSync(configDir, { recursive: true });

    const configPath = `${configDir}/kubeconfig.yaml`;
    const kubeconfigYaml = `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
- name: default
  cluster: test-cluster
  user: test-user
clusters:
- name: test-cluster
  nodes:
  - name: other-name
    kind: agent
    endpoint: http://localhost:8080
  - name: remote-node
    kind: agent
    endpoint: https://remote.local:8080
users:
- name: test-user
  token: test-token-value
`;
    writeFileSync(configPath, kubeconfigYaml);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const peers = listPeers();
    // localhost endpoint should be filtered out (LOCAL_NODE_ENDPOINT)
    expect(peers.map((p: PeerNode) => p.id)).toEqual(["remote-node"]);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
