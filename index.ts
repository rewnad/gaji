import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    force: { type: "boolean", default: false },
    run: { type: "string" },
    setup: { type: "string" },
    "no-setup": { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const cmd = positionals[0];
const name = positionals[1];
const target = positionals[2];
const defaultSetupScript = ".gaji/config.sh";

async function getRepoRoot() {
  const result = await Bun.$`git rev-parse --show-toplevel`.quiet();
  return result.text().trim();
}

async function getRepoBasename() {
  const top = await getRepoRoot();
  return top.split("/").pop()!;
}

async function worktreeDir(branch: string) {
  const base = await getRepoBasename();
  return `${homedir()}/.local/share/gaji/${base}/${branch}`;
}

function homedir() {
  return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

async function resolveSetupScript(script: string) {
  const repoRoot = await getRepoRoot();
  const scriptPath = isAbsolute(script) ? script : resolve(repoRoot, script);
  const exists = await Bun.file(scriptPath).exists();

  if (!exists) {
    console.error(`error: setup script not found: ${scriptPath}`);
    process.exit(1);
  }

  return scriptPath;
}

async function findDefaultSetupScript() {
  const repoRoot = await getRepoRoot();
  const scriptPath = resolve(repoRoot, defaultSetupScript);
  return (await Bun.file(scriptPath).exists()) ? scriptPath : null;
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
      console.error(
        `error: could not resolve worktree directory for "${name}"`,
      );
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
  const runCommand = values.run;
  const setupScript = values.setup;
  const noSetup = values["no-setup"];

  if (runCommand && setupScript) {
    console.error("error: --run and --setup cannot be used together");
    process.exit(1);
  }

  if (setupScript && noSetup) {
    console.error("error: --setup and --no-setup cannot be used together");
    process.exit(1);
  }

  const setupScriptPath = setupScript
    ? await resolveSetupScript(setupScript)
    : !runCommand && !noSetup
      ? await findDefaultSetupScript()
      : null;

  if (await branchExists(name)) {
    console.error(`error: branch "${name}" already exists`);
    process.exit(1);
  }

  if (!(await branchExists("dev"))) {
    console.error('error: base branch "dev" does not exist');
    process.exit(1);
  }

  await Bun.$`mkdir -p ${dir}`.quiet();
  await Bun.$`git worktree add -b ${name} ${dir} dev`.quiet();
  await Bun.$`tmux new-session -d -s ${name} -c ${dir}`.quiet();

  if (setupScriptPath) {
    const setupResult = await Bun.$`bash ${setupScriptPath}`
      .cwd(dir)
      .env({
        ...process.env,
        GAJI_SESSION: name,
        GAJI_DIR: dir,
        GAJI_BRANCH: name,
        GAJI_BASE: "dev",
      })
      .quiet()
      .nothrow();
    if (setupResult.exitCode !== 0) {
      console.error("error: created worktree, but setup script failed");
      printCommandFailure("setup script", setupResult);
      process.exit(1);
    }
  }

  if (runCommand) {
    await Bun.$`tmux send-keys -t ${name} -- ${runCommand} C-m`.quiet();
  }

  console.log(`created worktree: ${name}`);
  console.log(`  base:     dev`);
  console.log(`  branch:   ${name}`);
  console.log(`  path:     ${dir}`);
  console.log(`  session:  ${name}`);
  if (runCommand) {
    console.log(`  run:      ${runCommand}`);
  }
  if (setupScriptPath) {
    console.log(`  setup:    ${setupScriptPath}`);
  }
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
  console.log(
    `  branch:   ${mark(check.branch)} ${check.branch ? "exists" : "missing"}`,
  );
  console.log(
    `  worktree: ${mark(check.worktree)} ${check.worktree ? "exists" : "missing"}`,
  );
  console.log(
    `  tmux:     ${mark(check.tmux)} ${check.tmux ? "exists" : "missing"}`,
  );
  console.log("Aborting. All three must be present to remove.");
}

function printCommandFailure(
  label: string,
  result: { exitCode: number; stdout: Buffer; stderr: Buffer },
) {
  console.log(`    ${label} failed (exit ${result.exitCode})`);
  const output = [
    result.stderr.toString().trim(),
    result.stdout.toString().trim(),
  ]
    .filter(Boolean)
    .join("\n");
  if (output) {
    for (const line of output.split("\n")) {
      console.log(`      ${line}`);
    }
  }
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
  let failed = 0;

  for (const wt of worktrees) {
    const [hasBranch, hasTmux] = await Promise.all([
      branchExists(wt.branch),
      tmuxExists(wt.branch),
    ]);

    if (!hasBranch) {
      console.log(`  ⚠ ${wt.branch} — skipped (branch missing)`);
      skipped++;
      continue;
    }

    if (hasTmux) {
      console.log(`  ⚠ ${wt.branch} — skipped (tmux session exists)`);
      skipped++;
      continue;
    }

    console.log(`  ${wt.branch} — removing (${wt.path})`);

    const removeResult = values.force
      ? await Bun.$`git worktree remove --force ${wt.path}`.quiet().nothrow()
      : await Bun.$`git worktree remove ${wt.path}`.quiet().nothrow();
    if (removeResult.exitCode !== 0) {
      printCommandFailure("git worktree remove", removeResult);
      failed++;
      continue;
    }

    const branchResult = values.force
      ? await Bun.$`git branch -D ${wt.branch}`.quiet().nothrow()
      : await Bun.$`git branch -d ${wt.branch}`.quiet().nothrow();
    if (branchResult.exitCode !== 0) {
      printCommandFailure(
        values.force ? "git branch -D" : "git branch -d",
        branchResult,
      );
      failed++;
      continue;
    }

    console.log(`  ✓ ${wt.branch} — removed`);
    removed++;
  }

  const pruneResult = await Bun.$`git worktree prune`.quiet().nothrow();
  if (pruneResult.exitCode !== 0) {
    printCommandFailure("git worktree prune", pruneResult);
    failed++;
  }

  console.log(
    `\ndone: ${removed} removed, ${skipped} skipped, ${failed} failed`,
  );
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

  if (!(await branchExists(name))) {
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
  gaji new <name>        create a new worktree from dev and tmux session
  gaji new <name> --run <cmd>
  gaji new <name> --setup <script>
  gaji new <name> --no-setup
  gaji remove <name>     remove a worktree, tmux session, and branch
  gaji prune             remove all unused worktrees
  gaji merge <src> <tgt> merge source branch into target
  gaji switch <name>      switch to worktree tmux session

options:
  --run <cmd>            run a command in the new tmux session
  --setup <script>       run a tmux setup script after session creation
  --no-setup             skip automatic .gaji/config.sh setup
  --force                skip remove validation; force dirty prune cleanup`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
