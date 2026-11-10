/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects matchers are typed as void. */
import { expect, test } from "bun:test";

import type { ExecFn, ExecResult } from "../src/commands/update/deps.js";
import type { HistoryRef } from "../src/commands/update/history.js";

import {
  type BranchMode,
  changedFiles,
  commitsBetween,
  DEPLOY_BRANCH,
  describeMode,
  type GitFn,
  makeGit,
  originGithubRepo,
  readCheckout,
  resolveCommit,
  restoreMode,
  switchTo,
  UpdateError,
} from "../src/commands/update/git.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "", code = 1): ExecResult {
  return { code, stdout: "", stderr };
}

interface Scripted {
  git: GitFn;
  calls: string[];
}

function scripted(table: (args: readonly string[]) => ExecResult): Scripted {
  const calls: string[] = [];
  const git: GitFn = (args: readonly string[]): Promise<ExecResult> => {
    calls.push(args.join(" "));
    return Promise.resolve(table(args));
  };
  return { git, calls };
}

function byKey(table: Record<string, ExecResult>): (args: readonly string[]) => ExecResult {
  return (args: readonly string[]): ExecResult => table[args.join(" ")] ?? ok();
}

async function expectUpdateError(promise: Promise<unknown>, message: string): Promise<void> {
  await expect(promise).rejects.toThrow(message);
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UpdateError);
  expect((caught as Error).message).toBe(message);
}

test("makeGit prefixes argv with git -C <repo> and returns the exec result unchanged", async () => {
  const seen: string[][] = [];
  const result = ok("clean\n");
  const exec: ExecFn = (argv: readonly string[]): Promise<ExecResult> => {
    seen.push([...argv]);
    return Promise.resolve(result);
  };
  const git = makeGit(exec, "/srv/repo");
  const got = await git(["status"]);
  expect(seen).toEqual([["git", "-C", "/srv/repo", "status"]]);
  expect(got).toBe(result);
});

test("readCheckout reports sha, branch and dirty lines in a fixed argv order", async () => {
  const { git, calls } = scripted(
    byKey({
      "rev-parse HEAD": ok(`${A}\n`),
      "symbolic-ref --quiet --short HEAD": ok("feat/x\n"),
      "status --porcelain --untracked-files=no": ok(" M a.ts\n\n M b.ts\n"),
    }),
  );
  expect(await readCheckout(git)).toEqual({
    sha: A,
    branch: "feat/x",
    dirty: [" M a.ts", " M b.ts"],
  });
  expect(calls).toEqual([
    "rev-parse HEAD",
    "symbolic-ref --quiet --short HEAD",
    "status --porcelain --untracked-files=no",
  ]);
});

test("readCheckout reports a null branch when symbolic-ref exits non-zero", async () => {
  const { git } = scripted(
    byKey({
      "rev-parse HEAD": ok(`${A}\n`),
      "symbolic-ref --quiet --short HEAD": fail("fatal: ref HEAD is not a symbolic ref", 1),
    }),
  );
  expect(await readCheckout(git)).toEqual({ sha: A, branch: null, dirty: [] });
});

test("readCheckout reports a null branch for a blank symbolic-ref at exit 0", async () => {
  const { git } = scripted(
    byKey({
      "rev-parse HEAD": ok(`${A}\n`),
      "symbolic-ref --quiet --short HEAD": ok("  \n"),
    }),
  );
  expect(await readCheckout(git)).toEqual({ sha: A, branch: null, dirty: [] });
});

test("readCheckout: rev-parse failure without stderr reports the exit code", async () => {
  const { git } = scripted(byKey({ "rev-parse HEAD": fail("", 128) }));
  await expectUpdateError(readCheckout(git), "git rev-parse HEAD failed: exit 128");
});

test("readCheckout: rev-parse failure reports trimmed stderr", async () => {
  const { git } = scripted(byKey({ "rev-parse HEAD": fail("bad object\n", 128) }));
  await expectUpdateError(readCheckout(git), "git rev-parse HEAD failed: bad object");
});

test("readCheckout: status failure reports trimmed stderr", async () => {
  const { git } = scripted(
    byKey({
      "rev-parse HEAD": ok(`${A}\n`),
      "symbolic-ref --quiet --short HEAD": ok("main\n"),
      "status --porcelain --untracked-files=no": fail("index locked\n", 128),
    }),
  );
  await expectUpdateError(readCheckout(git), "git status failed: index locked");
});

test("resolveCommit verifies <ref>^{commit} and trims or nulls the output", async () => {
  const key = "rev-parse --verify --quiet origin/main^{commit}";
  const found = scripted(byKey({ [key]: ok(`${A}\n`) }));
  expect(await resolveCommit(found.git, "origin/main")).toBe(A);
  expect(found.calls).toEqual([key]);

  const nonZero = scripted(byKey({ [key]: fail("", 1) }));
  expect(await resolveCommit(nonZero.git, "origin/main")).toBeNull();

  const empty = scripted(byKey({ [key]: ok("") }));
  expect(await resolveCommit(empty.git, "origin/main")).toBeNull();
});

test("commitsBetween counts via rev-list and splits subjects on the first tab", async () => {
  const { git, calls } = scripted(
    byKey({
      "rev-list --count X..Y": ok("3\n"),
      "log --no-decorate -n5 --format=%H%x09%s X..Y": ok(
        `${A}\tfirst subject\n${B}\tsecond\twith tab`,
      ),
    }),
  );
  expect(await commitsBetween(git, "X", "Y", 5)).toEqual({
    count: 3,
    commits: [
      { sha: A, subject: "first subject" },
      { sha: B, subject: "second\twith tab" },
    ],
  });
  expect(calls).toEqual(["rev-list --count X..Y", "log --no-decorate -n5 --format=%H%x09%s X..Y"]);
});

test("commitsBetween falls back to the commit count when rev-list output is not numeric", async () => {
  const { git } = scripted(
    byKey({
      "rev-list --count X..Y": ok("not-a-number"),
      "log --no-decorate -n5 --format=%H%x09%s X..Y": ok(`${A}\tfirst\n${B}\tsecond`),
    }),
  );
  expect(await commitsBetween(git, "X", "Y", 5)).toEqual({
    count: 2,
    commits: [
      { sha: A, subject: "first" },
      { sha: B, subject: "second" },
    ],
  });
});

test("commitsBetween yields no commits for an empty log", async () => {
  const { git } = scripted(
    byKey({
      "rev-list --count X..Y": ok("7\n"),
      "log --no-decorate -n5 --format=%H%x09%s X..Y": ok(""),
    }),
  );
  expect(await commitsBetween(git, "X", "Y", 5)).toEqual({ count: 7, commits: [] });
});

test("commitsBetween treats a tab-less log line as a sha with an empty subject", async () => {
  const { git } = scripted(
    byKey({
      "rev-list --count X..Y": ok("1\n"),
      "log --no-decorate -n5 --format=%H%x09%s X..Y": ok(A),
    }),
  );
  expect(await commitsBetween(git, "X", "Y", 5)).toEqual({
    count: 1,
    commits: [{ sha: A, subject: "" }],
  });
});

test("changedFiles splits trimmed diff output and errors with stderr", async () => {
  const empty = scripted(byKey({ "diff --name-only F T": ok("") }));
  expect(await changedFiles(empty.git, "F", "T")).toEqual([]);

  const two = scripted(byKey({ "diff --name-only F T": ok("a.ts\nb/c.ts\n") }));
  expect(await changedFiles(two.git, "F", "T")).toEqual(["a.ts", "b/c.ts"]);

  const broken = scripted(byKey({ "diff --name-only F T": fail("boom", 1) }));
  await expectUpdateError(
    changedFiles(broken.git, "F", "T"),
    "git diff --name-only F T failed: boom",
  );
});

test("originGithubRepo parses the origin remote and nulls on failure", async () => {
  const ssh = scripted(
    byKey({ "remote get-url origin": ok("git@github.com:frozename/llamactl.git\n") }),
  );
  expect(await originGithubRepo(ssh.git)).toBe("frozename/llamactl");
  expect(ssh.calls).toEqual(["remote get-url origin"]);

  const missing = scripted(byKey({ "remote get-url origin": fail("no such remote", 2) }));
  expect(await originGithubRepo(missing.git)).toBeNull();
});

test("restoreMode detaches without git when the ref has no branch", async () => {
  const { git, calls } = scripted(byKey({}));
  const ref: HistoryRef = { branch: null, sha: A };
  expect(await restoreMode(git, ref)).toEqual({ kind: "detach" });
  expect(calls).toEqual([]);
});

test("restoreMode lands on main without git", async () => {
  const { git, calls } = scripted(byKey({}));
  const ref: HistoryRef = { branch: DEPLOY_BRANCH, sha: A };
  expect(await restoreMode(git, ref)).toEqual({ kind: "main" });
  expect(calls).toEqual([]);
});

test("restoreMode keeps a feature branch only while its tip matches the sha", async () => {
  const ref: HistoryRef = { branch: "feat/x", sha: A };
  const key = "rev-parse --verify --quiet refs/heads/feat/x^{commit}";

  const same = scripted(byKey({ [key]: ok(`${A}\n`) }));
  expect(await restoreMode(same.git, ref)).toEqual({ kind: "branch", name: "feat/x" });
  expect(same.calls).toEqual([key]);

  const moved = scripted(byKey({ [key]: ok(`${B}\n`) }));
  expect(await restoreMode(moved.git, ref)).toEqual({ kind: "detach" });

  const gone = scripted(byKey({ [key]: fail("", 1) }));
  expect(await restoreMode(gone.git, ref)).toEqual({ kind: "detach" });
});

test("describeMode words each landing mode", () => {
  const main: BranchMode = { kind: "main" };
  const branch: BranchMode = { kind: "branch", name: "feat/x" };
  const detach: BranchMode = { kind: "detach" };
  expect(describeMode(main)).toBe("branch main (tracking origin/main)");
  expect(describeMode(branch)).toBe("branch feat/x");
  expect(describeMode(detach)).toBe("a detached HEAD");
});

test("switchTo main force-creates the deploy branch and best-effort sets upstream", async () => {
  const { git, calls } = scripted(byKey({}));
  expect(await switchTo(git, A, { kind: "main" })).toBeNull();
  expect(calls).toEqual([
    `switch --quiet -C ${DEPLOY_BRANCH} ${A}`,
    `branch --quiet --set-upstream-to=origin/${DEPLOY_BRANCH} ${DEPLOY_BRANCH}`,
  ]);
});

test("switchTo main still returns null when setting the upstream fails", async () => {
  const { git } = scripted(
    byKey({
      [`branch --quiet --set-upstream-to=origin/${DEPLOY_BRANCH} ${DEPLOY_BRANCH}`]: fail(
        "no upstream",
        128,
      ),
    }),
  );
  expect(await switchTo(git, A, { kind: "main" })).toBeNull();
});

test("switchTo main stops on switch failure and reports stderr", async () => {
  const switchKey = `switch --quiet -C ${DEPLOY_BRANCH} ${A}`;
  const { git, calls } = scripted(byKey({ [switchKey]: fail("index.lock exists\n", 128) }));
  expect(await switchTo(git, A, { kind: "main" })).toBe(
    `git switch --quiet -C ${DEPLOY_BRANCH} ${A}: index.lock exists`,
  );
  expect(calls).toHaveLength(1);
});

test("switchTo main reports the exit code when the failing switch has no stderr", async () => {
  const { git } = scripted(byKey({ [`switch --quiet -C ${DEPLOY_BRANCH} ${A}`]: fail("", 128) }));
  expect(await switchTo(git, A, { kind: "main" })).toBe(
    `git switch --quiet -C ${DEPLOY_BRANCH} ${A}: exit 128`,
  );
});

test("switchTo branch stays on the branch when HEAD matches the sha", async () => {
  const { git, calls } = scripted(
    byKey({
      "switch --quiet feat/x": ok(),
      "rev-parse --verify --quiet HEAD^{commit}": ok(`${A}\n`),
    }),
  );
  expect(await switchTo(git, A, { kind: "branch", name: "feat/x" })).toBeNull();
  expect(calls).toEqual(["switch --quiet feat/x", "rev-parse --verify --quiet HEAD^{commit}"]);
});

test("switchTo branch detaches when HEAD does not match the sha", async () => {
  const { git, calls } = scripted(
    byKey({
      "switch --quiet feat/x": ok(),
      "rev-parse --verify --quiet HEAD^{commit}": ok(`${B}\n`),
    }),
  );
  expect(await switchTo(git, A, { kind: "branch", name: "feat/x" })).toBeNull();
  expect(calls).toEqual([
    "switch --quiet feat/x",
    "rev-parse --verify --quiet HEAD^{commit}",
    `switch --quiet --detach ${A}`,
  ]);
});

test("switchTo branch falls back to detach when the branch switch fails", async () => {
  const { git, calls } = scripted(
    byKey({ "switch --quiet feat/x": fail("invalid reference", 128) }),
  );
  expect(await switchTo(git, A, { kind: "branch", name: "feat/x" })).toBeNull();
  expect(calls).toEqual(["switch --quiet feat/x", `switch --quiet --detach ${A}`]);
});

test("switchTo branch reports the detach failure when the fallback also fails", async () => {
  const { git } = scripted(
    byKey({
      "switch --quiet feat/x": fail("invalid reference", 128),
      [`switch --quiet --detach ${A}`]: fail("locked", 128),
    }),
  );
  expect(await switchTo(git, A, { kind: "branch", name: "feat/x" })).toBe(
    `git switch --quiet --detach ${A}: locked`,
  );
});

test("switchTo detach runs a single detach and returns null", async () => {
  const { git, calls } = scripted(byKey({}));
  expect(await switchTo(git, A, { kind: "detach" })).toBeNull();
  expect(calls).toEqual([`switch --quiet --detach ${A}`]);
});
