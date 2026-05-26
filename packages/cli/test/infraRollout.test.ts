
import { test, expect } from "bun:test";
import { planRollout, runRollout, runRollback } from "../../fleet-supervisor/src/infra-rollout.js";
import type { PeerNode } from "../../remote/src/config/peers.js";

const mockPeers: PeerNode[] = [
  { id: "node-a", endpoint: "http://a" } as any,
  { id: "node-b", endpoint: "http://b" } as any,
  { id: "m4-pro-local", endpoint: "http://local" } as any,
];

test("T5: orchestrating node appears last in rollout sequence", () => {
  const groups = planRollout(mockPeers, "m4-pro-local", "one-at-a-time");
  expect(groups.length).toBe(3);
  expect(groups[2]![0]!.id).toBe("m4-pro-local");
  
  const groupsAll = planRollout(mockPeers, "m4-pro-local", "all");
  expect(groupsAll.length).toBe(2);
  expect(groupsAll[0]!.map(n => n.id).sort()).toEqual(["node-a", "node-b"].sort());
  expect(groupsAll[1]![0]!.id).toBe("m4-pro-local");
});

test("T1: one-at-a-time strategy: install->activate->health completes before next", async () => {
  const events: string[] = [];
  const mockClientFactory = (peer: PeerNode) => ({
    install: async () => { events.push(`install ${peer.id}`); },
    activate: async () => { events.push(`activate ${peer.id}`); },
    pollHealth: async () => { events.push(`health ${peer.id}`); return "healthy" as const; }
  });

  const groups = planRollout(mockPeers, "m4-pro-local", "one-at-a-time");
  await runRollout(groups, mockClientFactory, { pkg: "p", version: "v", tarballUrl: "u", sha256: "s", skipIfPresent: true });

  expect(events).toEqual([
    "install node-a", "activate node-a", "health node-a",
    "install node-b", "activate node-b", "health node-b",
    "install m4-pro-local", "activate m4-pro-local", "health m4-pro-local"
  ]);
});

test("T2: rollout halts at node B when health gate fails on node A", async () => {
  const events: string[] = [];
  const mockClientFactory = (peer: PeerNode) => ({
    install: async () => { events.push(`install ${peer.id}`); },
    activate: async () => { events.push(`activate ${peer.id}`); },
    pollHealth: async () => { 
      events.push(`health ${peer.id}`); 
      return peer.id === "node-a" ? "timeout" as const : "healthy" as const; 
    }
  });

  const groups = planRollout(mockPeers, "m4-pro-local", "one-at-a-time");
  const result = await runRollout(groups, mockClientFactory, { pkg: "p", version: "v", tarballUrl: "u", sha256: "s", skipIfPresent: true });

  expect(result.ok).toBe(false);
  expect(events).toEqual([
    "install node-a", "activate node-a", "health node-a"
  ]);
});

test("T3: --strategy=all fires all installs concurrently before any activates", async () => {
  const events: string[] = [];
  const mockClientFactory = (peer: PeerNode) => ({
    install: async () => { 
      await new Promise(r => setTimeout(r, 10));
      events.push(`install ${peer.id}`); 
    },
    activate: async () => { events.push(`activate ${peer.id}`); },
    pollHealth: async () => { events.push(`health ${peer.id}`); return "healthy" as const; }
  });

  const groups = planRollout(mockPeers, "m4-pro-local", "all");
  await runRollout(groups, mockClientFactory, { pkg: "p", version: "v", tarballUrl: "u", sha256: "s", skipIfPresent: true });

  const group1 = events.slice(0, 6);
  expect(group1).toContain("install node-a");
  expect(group1).toContain("install node-b");
  expect(group1.indexOf("install node-a")).toBeLessThan(group1.indexOf("activate node-a"));
  expect(group1.indexOf("install node-b")).toBeLessThan(group1.indexOf("activate node-a"));
  expect(events.slice(6)).toEqual([
    "install m4-pro-local", "activate m4-pro-local", "health m4-pro-local"
  ]);
});

test("T4: rollback calls activate(previousVersion) on each node", async () => {
  const events: string[] = [];
  const mockClientFactory = (peer: PeerNode) => ({
    install: async () => { },
    activate: async (args: { pkg: string, version: string }) => { 
      events.push(`activate ${peer.id} ${args.version}`); 
    },
    pollHealth: async () => "healthy" as const
  });

  await runRollback(mockPeers, mockClientFactory, { pkg: "p", previousVersion: "v1" });

  expect(events).toEqual([
    "activate node-a v1",
    "activate node-b v1",
    "activate m4-pro-local v1"
  ]);
});
