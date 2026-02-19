import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, cpSync, statSync } from "fs";
import { join, basename } from "path";
import { readConfig, writeConfig } from "../config.js";
import { getLatestTag, isNewer, cloneAtTag } from "../git.js";
import { generateAgentsMd, generateClaudeMdPointer, generateCopilotInstructions, generateReadme, buildSkillTable } from "./init.js";
import { load } from "js-yaml";
import { execSync } from "child_process";
import * as ui from "../ui.js";

// Sync skills, frameworks first — cli/ is replaced LAST
// so the currently running process doesn't lose its own files mid-execution.
const CONTENT_DIRS = ["skills", "frameworks"];

export function update(): void {
  const config = readConfig();
  const cwd = process.cwd();

  console.log();
  const spin1 = ui.spinner("Checking for updates...");
  const latest = getLatestTag(config.coreRepo);

  if (!latest) {
    spin1.stop();
    ui.error("Could not determine latest version.");
    console.log();
    return;
  }

  if (!isNewer(latest, config.version)) {
    spin1.stop(`Already up to date (v${config.version})`);
    console.log();
    return;
  }

  spin1.stop(`Update available: v${config.version} ${ui.accent("→")} v${latest}`);
  console.log();

  // Clone the latest tag to a temp directory
  const spin2 = ui.spinner("Downloading...");
  const tmpDir = cloneAtTag(config.coreRepo, latest);
  spin2.stop("Downloaded");

  // Sync content directories (skills, frameworks) — preserve custom items
  const stats = { skills: 0, frameworks: 0, customSkills: 0, customFrameworks: 0, collisions: [] as string[] };

  for (const dir of CONTENT_DIRS) {
    const srcDir = join(tmpDir, dir);
    const destDir = join(cwd, dir);

    if (!existsSync(srcDir)) continue;

    // Identify core items (what ships in this release)
    const coreItems = new Set(
      readdirSync(srcDir).filter((f) => !f.startsWith("."))
    );

    // Identify custom items (client has it, core doesn't)
    const customItems: string[] = [];
    if (existsSync(destDir)) {
      for (const item of readdirSync(destDir)) {
        if (item.startsWith(".") || item.startsWith("_")) continue;
        if (!coreItems.has(item)) {
          customItems.push(item);
        }
      }
    }

    // Save custom items to temp before replacing
    const customTmp = join(tmpDir, `_custom_${dir}`);
    if (customItems.length > 0) {
      mkdirSync(customTmp, { recursive: true });
      for (const item of customItems) {
        cpSync(join(destDir, item), join(customTmp, item), { recursive: true });
      }
    }

    // Count core items for summary
    const coreCount = dir === "skills"
      ? readdirSync(srcDir).filter((f) => statSync(join(srcDir, f)).isDirectory()).length
      : readdirSync(srcDir).filter((f) => f.endsWith(".md") || statSync(join(srcDir, f)).isDirectory()).length;

    if (dir === "skills") stats.skills = coreCount;
    else if (dir === "frameworks") stats.frameworks = coreCount;

    // Full replace of core content
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true });
    }
    cpSync(srcDir, destDir, { recursive: true });

    // Restore custom items
    if (customItems.length > 0) {
      for (const item of customItems) {
        const restoreDest = join(destDir, item);

        // Name collision: core added an item with the same name as a custom one
        if (coreItems.has(item)) {
          cpSync(join(customTmp, item), join(destDir, `${item}.custom-backup`), { recursive: true });
          stats.collisions.push(item);
        } else {
          cpSync(join(customTmp, item), restoreDest, { recursive: true });
        }
      }

      if (dir === "skills") stats.customSkills = customItems.length;
      if (dir === "frameworks") stats.customFrameworks = customItems.length;
    }

    ui.success(`${dir.charAt(0).toUpperCase() + dir.slice(1)} updated (${stats[dir as keyof typeof stats]})`);
  }

  // Report custom preservation
  const totalCustom = stats.customSkills + stats.customFrameworks;
  if (totalCustom > 0) {
    const parts: string[] = [];
    if (stats.customSkills > 0) parts.push(`${stats.customSkills} skill${stats.customSkills > 1 ? "s" : ""}`);
    if (stats.customFrameworks > 0) parts.push(`${stats.customFrameworks} framework${stats.customFrameworks > 1 ? "s" : ""}`);
    ui.success(`Custom preserved (${parts.join(", ")})`);
  }

  // Warn about name collisions
  if (stats.collisions.length > 0) {
    console.log();
    ui.warn("Name collisions with new core items:");
    for (const name of stats.collisions) {
      console.log(`    ${ui.dim("→")} ${name} ${ui.dim("(your version backed up to " + name + ".custom-backup)")}`);
    }
  }

  // Regenerate AI instruction files (using client's skills dir which now has core + custom)
  const clientName = config.client.name;
  const clientSkillsDir = join(cwd, "skills");
  const agentsTemplatePath = join(tmpDir, "agents-template.md");
  if (existsSync(agentsTemplatePath)) {
    let template = readFileSync(agentsTemplatePath, "utf-8");
    template = template.replace(/\{client_name\}/g, clientName);
    // Replace the hardcoded skill table placeholder if present
    const dynamicTable = buildSkillTable(clientSkillsDir);
    template = template.replace(/\{skill_table\}/g, dynamicTable);
    writeFileSync(join(cwd, "AGENTS.md"), template);
  } else {
    writeFileSync(join(cwd, "AGENTS.md"), generateAgentsMd(clientName, clientSkillsDir));
  }
  writeFileSync(join(cwd, "CLAUDE.md"), generateClaudeMdPointer(clientSkillsDir));
  mkdirSync(join(cwd, ".github"), { recursive: true });
  writeFileSync(join(cwd, ".github", "copilot-instructions.md"), generateCopilotInstructions());
  writeFileSync(join(cwd, "README.md"), generateReadme(clientName));
  ui.success("AI instructions regenerated");

  // Check for missing context files
  const contextPath = config.client.contextPath || "./context";
  checkMissingContext(tmpDir, join(cwd, contextPath));

  // Update config version BEFORE replacing cli/ — if the cli/ swap
  // causes the process to error, the version is already recorded so
  // a re-run won't re-download and re-apply the same update.
  config.version = latest;
  config.lastUpdated = new Date().toISOString();
  writeConfig(config);

  // Replace cli/ LAST — this is the currently running code, so anything
  // after this point may fail if Node can't resolve replaced modules.
  // IMPORTANT: Overwrite in-place instead of delete-then-copy. The client's
  // node_modules/baseline-cli is a symlink to cli/, so deleting cli/ first
  // would break the symlink and leave dist/index.js missing if anything fails.
  const cliSrc = join(tmpDir, "cli");
  const cliDest = join(cwd, "cli");
  if (existsSync(cliSrc)) {
    cpSync(cliSrc, cliDest, { recursive: true, force: true });

    // Remove CLI source files (clients only need bin/, dist/, package.json)
    const cliCleanup = ["src", "tsconfig.json", "package-lock.json"];
    for (const item of cliCleanup) {
      const p = join(cwd, "cli", item);
      if (existsSync(p)) rmSync(p, { recursive: true });
    }
  }
  ui.success("CLI updated");

  // Re-install CLI dependencies after update
  if (existsSync(join(cwd, "package.json"))) {
    const spin3 = ui.spinner("Installing dependencies...");
    try {
      execSync("npm install --silent", { cwd, stdio: "pipe" });
      spin3.stop("Dependencies installed");
    } catch {
      spin3.stop("Dependencies (using previous install)");
    }
  }

  // Clean up temp dir
  rmSync(tmpDir, { recursive: true });

  const summaryRows: [string, string][] = [
    ["Skills:", stats.customSkills > 0 ? `${stats.skills} core + ${stats.customSkills} custom` : `${stats.skills}`],
    ["Frameworks:", stats.customFrameworks > 0 ? `${stats.frameworks} core + ${stats.customFrameworks} custom` : `${stats.frameworks}`],
  ];
  ui.summary(`Updated to v${latest}`, summaryRows);
  console.log();
}

interface ManifestContext {
  core?: string[];
  extended?: string[];
}

interface Manifest {
  context?: ManifestContext;
}

function checkMissingContext(coreDir: string, contextDir: string): void {
  const skillsDir = join(coreDir, "skills");
  if (!existsSync(skillsDir)) return;

  const missingMap = new Map<string, string[]>();

  for (const skill of readdirSync(skillsDir)) {
    const manifestPath = join(skillsDir, skill, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = load(readFileSync(manifestPath, "utf-8")) as Manifest;
      if (!manifest?.context?.extended) continue;

      for (const ctxPath of manifest.context.extended) {
        const match = ctxPath.match(/context\/\{client\}\/(.+)/);
        if (!match) continue;

        const relPath = match[1];
        const fullPath = join(contextDir, relPath);
        if (!existsSync(fullPath)) {
          if (!missingMap.has(relPath)) missingMap.set(relPath, []);
          missingMap.get(relPath)!.push(skill);
        }
      }
    } catch {
      // Skip unparseable manifests
    }
  }

  if (missingMap.size > 0) {
    console.log();
    ui.warn("Missing context files:");
    for (const [file, skills] of missingMap) {
      console.log(`    ${ui.dim("→")} ${file} ${ui.dim(`(used by ${skills.join(", ")})`)}`);
    }
    ui.info("Create these files to get the most out of these skills.");
  }
}
