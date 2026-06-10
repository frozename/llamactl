import { useMemo } from "react";

import { trpc } from "@/lib/trpc";

export type NodeKind = "agent" | "gateway" | "provider" | "rag" | "cloud";
export interface N {
  name: string;
  endpoint: string;
  effectiveKind: NodeKind;
  isLocal?: boolean;
}

export function useMockNodes(): N[] {
  const list = trpc.nodeList.useQuery();
  return useMemo(() => {
    const raw = list.data?.nodes ?? [];
    const out: N[] = raw.map((n) => ({
      name: n.name,
      endpoint: n.endpoint,
      effectiveKind: n.effectiveKind,
      isLocal: n.name === "local",
    }));
    if (!out.some((n) => n.name === "local")) {
      out.unshift({
        name: "local",
        endpoint: "inproc://local",
        effectiveKind: "agent",
        isLocal: true,
      });
    }
    return out;
  }, [list.data]);
}
