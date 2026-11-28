import type { ModelHostReadiness } from "@llamactl/core/engines/types";
import type { SelectLocalEngineReadiness } from "@llamactl/core/residency/engine-forwarder";

import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { AsyncLocalStorage } from "node:async_hooks";

import type { NativeRuntimeGeneration } from "../residency/admission-authority.js";
import type { OmlxNativeBinding } from "../residency/engine-client.js";
import type { ConnectOmlxOwnerSocket } from "../residency/omlx-owner-socket.js";
import type { SelectOwnerTransport } from "../residency/owner-admission.js";
import type { VerifyParkedOmlxProbe } from "./modelhost.js";

import {
  createDurableOmlxParking,
  type DurableOmlxParkingOptions,
  type NativeOmlxResidencyAction,
  type NativeOmlxResidencyResult,
} from "../residency/durable-omlx-parking.js";
import { buildBaseUrl } from "../residency/engine-client.js";
import { createOmlxOwnerFetch } from "../residency/omlx-owner-http.js";

type OwnerParkingDeps = Pick<
  DurableOmlxParkingOptions,
  "authority" | "readLimits" | "readInferenceHold"
> & { verifyOwner(workload: string): boolean };

interface OmlxOwnerRegistration {
  apiKey: string;
  binding: OmlxNativeBinding;
  connect: ConnectOmlxOwnerSocket;
  current(): boolean;
  readiness: ModelHostReadiness;
  runtime: NativeRuntimeGeneration;
  specHash: string;
  verifyLaunchInputs(): boolean;
}

interface RegisteredOmlxHost {
  origin: string;
  transport: typeof fetch;
  readinessPath: string;
  read: typeof fetch;
  current(): boolean;
  runtime: NativeRuntimeGeneration;
  specHash: string;
  parking?: ReturnType<typeof createDurableOmlxParking>;
}

function registerParking(
  deps: OwnerParkingDeps | undefined,
  registration: OmlxOwnerRegistration,
  connect: ConnectOmlxOwnerSocket,
): RegisteredOmlxHost["parking"] {
  const registry = getResidencyLeaseRegistry();
  if (deps === undefined || registry === null) return undefined;
  const { apiKey, binding, readiness, runtime } = registration;
  return createDurableOmlxParking({
    ...deps,
    activityObservable: true,
    apiKey,
    binding,
    connect,
    readiness,
    runtime,
    registry,
    verifyExclusiveIngress: () =>
      deps.verifyOwner(runtime.workload) &&
      registration.current() &&
      registration.verifyLaunchInputs(),
    qualifiedResidualGiB: () => undefined,
  });
}

function newRegisteredOmlxHost(
  registration: OmlxOwnerRegistration,
  parkingDeps: OwnerParkingDeps | undefined,
): RegisteredOmlxHost {
  const { apiKey, binding, connect, readiness, runtime, specHash } = registration;
  const { workload } = runtime;
  const { endpoint } = binding;
  const readinessPath = readiness.path;
  const current = (): boolean => registration.current();
  const origin = new URL(buildBaseUrl(endpoint.host, endpoint.port)).origin;
  const target = new URL(origin + readinessPath).href;
  const guardedConnect: ConnectOmlxOwnerSocket = async (signal) => {
    const socket = await connect(signal);
    if (current()) return socket;
    socket.destroy();
    throw new Error("oMLX engine generation changed");
  };
  const direct = createOmlxOwnerFetch(endpoint, { connect: guardedConnect });
  const read = Object.assign(
    (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        url.href !== target ||
        !current() ||
        getResidencyLeaseRegistry()?.snapshot(workload).phase !== "open"
      ) {
        return Promise.reject(new Error("oMLX readiness binding is no longer current"));
      }
      return direct(url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      });
    },
    { preconnect: direct.preconnect },
  );
  const parking = registerParking(parkingDeps, registration, guardedConnect);
  return {
    origin,
    readinessPath,
    read,
    transport: createOmlxOwnerFetch(endpoint, {
      inferenceKey: apiKey,
      connect: guardedConnect,
    }),
    current,
    runtime,
    specHash,
    ...(parking === undefined ? {} : { parking }),
  };
}

const ownerScope = new AsyncLocalStorage<ReturnType<typeof createNativeOmlxOwner>>();
const completions = new Set(["/v1/chat/completions", "/v1/completions"]);

export function currentNativeOmlxOwner(): ReturnType<typeof createNativeOmlxOwner> | undefined {
  return ownerScope.getStore();
}

export function createNativeOmlxOwner(
  protectedWorkloads: readonly string[],
  ports: ReadonlySet<number>,
  requiresPrivateTransport: (workload: string) => boolean,
): {
  run: <T>(operation: () => T) => T;
  canServe(port: number): boolean;
  protect(workload: string): void;
  clear(workload: string): void;
  configureParking(deps: OwnerParkingDeps): void;
  register(registration: OmlxOwnerRegistration): void;
  setNativeResidency(
    workload: string,
    action: NativeOmlxResidencyAction,
  ): Promise<NativeOmlxResidencyResult | undefined>;
  verifyParked: VerifyParkedOmlxProbe;
  select: SelectOwnerTransport;
  readiness: SelectLocalEngineReadiness;
} {
  const protectedNames = new Set(protectedWorkloads);
  const registered = new Map<string, RegisteredOmlxHost>();
  let parkingDeps: OwnerParkingDeps | undefined;
  const isProtected = (workload: string): boolean =>
    protectedNames.has(workload) || requiresPrivateTransport(workload);
  const owner: ReturnType<typeof createNativeOmlxOwner> = {
    run<T>(operation: () => T): T {
      return ownerScope.run(owner, operation);
    },
    canServe(port: number): boolean {
      return ports.has(port);
    },
    protect(workload: string): void {
      protectedNames.add(workload);
      registered.delete(workload);
    },
    clear(workload: string): void {
      protectedNames.delete(workload);
      registered.delete(workload);
    },
    configureParking(deps: OwnerParkingDeps): void {
      parkingDeps = deps;
    },
    register(registration: OmlxOwnerRegistration): void {
      const { workload } = registration.runtime;
      protectedNames.add(workload);
      registered.set(workload, newRegisteredOmlxHost(registration, parkingDeps));
    },
    async setNativeResidency(
      workload: string,
      action: NativeOmlxResidencyAction,
    ): Promise<NativeOmlxResidencyResult | undefined> {
      const registration = registered.get(workload);
      const parking = registration?.parking;
      if (parking === undefined || registration?.current() !== true) return undefined;
      return action === "park" ? await parking.unload() : await parking.load();
    },
    async verifyParked(identity, signal): Promise<boolean> {
      const registration = registered.get(identity.workload);
      const parking = registration?.parking;
      if (
        signal.aborted ||
        registration?.runtime.pid !== identity.pid ||
        registration.specHash !== identity.specHash ||
        registration.origin !==
          new URL(buildBaseUrl(identity.endpoint.host, identity.endpoint.port)).origin ||
        parking === undefined
      )
        return false;
      return await parking.verifyParked(signal);
    },
    readiness(
      route: { workload: string; host: string; port: number },
      path: string,
    ): typeof fetch | null | undefined {
      if (!isProtected(route.workload)) return undefined;
      const binding = registered.get(route.workload);
      return binding?.origin === new URL(buildBaseUrl(route.host, route.port)).origin &&
        binding.readinessPath === path &&
        binding.current() &&
        getResidencyLeaseRegistry()?.snapshot(route.workload).phase === "open"
        ? binding.read
        : null;
    },
    select(target: string, workload?: string): typeof fetch | null | undefined {
      if (workload === undefined || !isProtected(workload)) return undefined;
      const binding = registered.get(workload);
      const url = new URL(target);
      return binding?.origin === url.origin &&
        url.search === "" &&
        completions.has(url.pathname) &&
        binding.current()
        ? binding.transport
        : null;
    },
  };
  return owner;
}
