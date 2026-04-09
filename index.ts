import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    force: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const cmd = positionals[0];
const name = positionals[1];
const target = positionals[2];

async function sh(cmd: TemplateStringsArray, ...args: string[]) {
  return Bun.$`${cmd.raw[0]} ${args}`.quiet();
}

async function getRepoBasename() {
  const result = await Bun.$`git rev-parse --show-toplevel`.quiet();
  const top = result.text().trim();
  return top.split("/").pop()!;
}

async function worktreeDir(branch: string) {
  const base = await getRepoBasename();
  return `${homedir()}/.local/share/gaji/${base}/${branch}`;
}

function homedir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

async function branchExists(branch: string) {
  const result = await Bun.$`git branch --list ${branch}`.quiet().nothrow();
  return result.text().trim().length > 0;
}

async function worktreeExists(branch: string) {
  const result = await Bun.$`git worktree list --porcelain`.quiet();
  const dir = await worktreeDir(branch);
  return result.text().includes(dir);
}

async function tmuxExists(session: string) {
  const result = await Bun.$`tmux has-session -t ${session}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function isWorktreeInUse(branch: string) {
  const result = await Bun.$`tmux list-clients -t ${branch}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function resolveWorktreeDir(branch: string) {
  const result = await Bun.$`git worktree list --porcelain`.quiet();
  let currentPath = "";
  for (const line of result.text().split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    }
    if (line.startsWith("branch refs/heads/") && line.endsWith(branch)) {
      return currentPath;
    }
  }
  return null;
}

async function switchWorktree() {
  if (!name) {
    console.error("error: name is required");
    process.exit(1);
  }

  const hasTmux = await tmuxExists(name);
  const hasWorktree = await worktreeExists(name);

  if (!hasTmux && !hasWorktree) {
    console.error(`error: no worktree or tmux session "${name}"`);
    process.exit(1);
  }

  if (!hasTmux && hasWorktree) {
    const dir = await resolveWorktreeDir(name);
    if (!dir) {
      console.error(`error: could not resolve worktree directory for "${name}"`);
      process.exit(1);
    }
    await Bun.$`tmux new-session -d -s ${name} -c ${dir}`.quiet();
  }

  const inTmux = !!process.env.TMUX;
  if (inTmux) {
    await Bun.$`tmux switch-client -t ${name}`;
  } else {
    await Bun.$`tmux attach -t ${name}`;
  }
}

async function listWorktrees() {
  const result = await Bun.$`git worktree list`.quiet();
  console.log(result.text());
}

async function newWorktree() {
  if (!name) {
    console.error("error: name is required");
    process.exit(1);
  }

  const dir = await worktreeDir(name);

  if (await branchExists(name)) {
    console.error(`error: branch "${name}" already exists`);
    process.exit(1);
  }

  await Bun.$`git branch ${name}`.quiet();
  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.$`git worktree add ${dir} ${name}`.quiet();
  await Bun.$`tmux new-session -d -s ${name} -c ${dir}`.quiet();

  console.log(`created worktree: ${name}`);
  console.log(`  branch:   ${name}`);
  console.log(`  path:     ${dir}`);
  console.log(`  session:  ${name}`);
}

type ResourceCheck = { branch: boolean; worktree: boolean; tmux: boolean };

async function checkResources(branch: string): Promise<ResourceCheck> {
  const [b, w, t] = await Promise.all([
    branchExists(branch),
    worktreeExists(branch),
    tmuxExists(branch),
  ]);
  return { branch: b, worktree: w, tmux: t };
}

function printCheck(name: string, check: ResourceCheck) {
  const mark = (exists: boolean) => (exists ? "✓" : "✗");
  console.log(`error: incomplete state for "${name}":`);
  console.log(`  branch:   ${mark(check.branch)} ${check.branch ? "exists" : "missing"}`);
  console.log(`  worktree: ${mark(check.worktree)} ${check.worktree ? "exists" : "missing"}`);
  console.log(`  tmux:     ${mark(check.tmux)} ${check.tmux ? "exists" : "missing"}`);
  console.log("Aborting. All three must be present to remove.");
}

async function removeWorktree() {
  if (!name) {
    console.error("error: name is required");
    process.exit(1);
  }

  const check = await checkResources(name);

  if (!values.force) {
    const allExist = check.branch && check.worktree && check.tmux;
    if (!allExist) {
      printCheck(name, check);
      process.exit(1);
    }
  }

  const dir = await worktreeDir(name);

  if (check.worktree) {
    await Bun.$`git worktree remove ${dir}`.quiet();
  }
  if (check.tmux) {
    await Bun.$`tmux kill-session -t ${name}`.quiet().nothrow();
  }
  if (check.branch) {
    await Bun.$`git branch -d ${name}`.quiet();
  }

  console.log(`removed: ${name}`);
}

async function pruneWorktrees() {
  const listResult = await Bun.$`git worktree list --porcelain`.quiet();
  const topResult = await Bun.$`git rev-parse --show-toplevel`.quiet();
  const mainDir = topResult.text().trim();

  const worktrees: { path: string; branch: string }[] = [];
  let currentPath = "";
  for (const line of listResult.text().split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      const branch = ref.replace("refs/heads/", "");
      if (currentPath !== mainDir) {
        worktrees.push({ path: currentPath, branch });
      }
    }
  }

  if (worktrees.length === 0) {
    console.log("no worktrees to prune");
    return;
  }

  console.log(`pruning ${worktrees.length} worktree(s):\n`);

  let removed = 0;
  let skipped = 0;

  for (const wt of worktrees) {
    const check = await checkResources(wt.branch);
    const allExist = check.branch && check.worktree && check.tmux;

    if (!allExist) {
      const missing: string[] = [];
      if (!check.branch) missing.push("branch missing");
      if (!check.worktree) missing.push("worktree missing");
      if (!check.tmux) missing.push("tmux missing");
      console.log(`  ⚠ ${wt.branch} — skipped (${missing.join(", ")})`);
      skipped++;
      continue;
    }

    const inUse = await isWorktreeInUse(wt.branch);
    if (inUse) {
      console.log(`  ⚠ ${wt.branch} — skipped (session is active)`);
      skipped++;
      continue;
    }

    const dir = await worktreeDir(wt.branch);
    await Bun.$`git worktree remove ${dir}`.quiet();
    await Bun.$`tmux kill-session -t ${wt.branch}`.quiet().nothrow();
    await Bun.$`git branch -d ${wt.branch}`.quiet();
    console.log(`  ✓ ${wt.branch} — removed`);
    removed++;
  }

  await Bun.$`git worktree prune`.quiet();
  console.log(`\ndone: ${removed} removed, ${skipped} skipped`);
}

async function mergeWorktree() {
  if (!name || !target) {
    console.error("error: source and target branches are required");
    process.exit(1);
  }

  const targetCheck = await checkResources(target);
  if (!targetCheck.worktree) {
    console.error(`error: target "${target}" has no worktree`);
    process.exit(1);
  }

  if (!await branchExists(name)) {
    console.error(`error: source branch "${name}" does not exist`);
    process.exit(1);
  }

  const dir = await worktreeDir(target);
  await Bun.$`git -C ${dir} merge ${name}`.quiet();

  console.log(`merged "${name}" into "${target}"`);
}

async function main() {
  switch (cmd) {
    case "list":
      return listWorktrees();
    case "new":
      return newWorktree();
    case "remove":
      return removeWorktree();
    case "prune":
      return pruneWorktrees();
    case "merge":
      return mergeWorktree();
    case "switch":
      return switchWorktree();
    default:
      console.log(`gaji - ergonomic git worktree + tmux workflows

usage:
  gaji list              list current worktrees
  gaji new <name>        create a new worktree and tmux session
  gaji remove <name>     remove a worktree, tmux session, and branch
  gaji prune             remove all unused worktrees
  gaji merge <src> <tgt> merge source branch into target
  gaji switch <name>      switch to worktree tmux session

options:
  --force                skip validation on remove (clean up partial state)`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});