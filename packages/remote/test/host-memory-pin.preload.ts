import { mock } from "bun:test";
import nodeOs from "node:os";

// #274: opt-in host-memory pin. When LLAMACTL_TEST_TOTALMEM_GIB is set to a
// positive number, os.totalmem() reports that many GiB for the whole run so
// admission-budget tests can be proven machine-independent against a small
// host. It is registered before any test module binds totalmem. The mock is
// inert when the flag is unset, so it never affects normal runs or CI.
const raw = process.env["LLAMACTL_TEST_TOTALMEM_GIB"];
const gib = raw === undefined ? Number.NaN : Number(raw);
if (Number.isFinite(gib) && gib > 0) {
  const bytes = gib * 1024 ** 3;
  void mock.module("node:os", () => {
    const patched = { ...nodeOs, totalmem: (): number => bytes };
    return { ...patched, default: patched };
  });
}
