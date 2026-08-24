import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(harnessRoot, "..")
const bridgeRoot = resolve(harnessRoot, "apps", "anton-bridge")
const contextRoot = resolve(sourceRoot, "c0ntext")
const outputArgument = process.argv[2]
// Never rewrite the installed app in place: the running Harness lazily imports
// provider modules and launches rg from that tree. An in-place rsync --delete
// can therefore make a live turn lose a module or executable halfway through.
// Build a complete side-by-side candidate, then install it only after stopping
// the old app.
const appRoot = resolve(harnessRoot, outputArgument ?? "dist/Anton.next.app")
const contents = join(appRoot, "Contents")
const resources = join(contents, "Resources")
const macOS = join(contents, "MacOS")
const nodeVersion = "22.19.0"

function run(command: string[], cwd = bridgeRoot): void {
  const [binary, ...args] = command
  if (binary === undefined) throw new Error("run() requires a non-empty command")
  const result = spawnSync(binary, args, { cwd, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed with status ${result.status}`)
}

function bundledNode(destination: string): void {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined
  if (architecture === undefined) throw new Error(`Unsupported macOS architecture: ${process.arch}`)
  const archiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`
  const temporary = mkdtempSync(join(tmpdir(), "anton-node-"))
  const archive = join(temporary, archiveName)
  const checksums = join(temporary, "SHASUMS256.txt")
  try {
    run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", archive, `${baseUrl}/${archiveName}`])
    run(["curl", "--fail", "--location", "--silent", "--show-error", "--output", checksums, `${baseUrl}/SHASUMS256.txt`])
    const expected = readFileSync(checksums, "utf8").split("\n").find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0]
    const actual = spawnSync("shasum", ["-a", "256", archive], { encoding: "utf8" }).stdout.split(/\s+/)[0]
    if (expected === undefined || actual !== expected) throw new Error(`Node ${nodeVersion} archive checksum verification failed`)
    run(["tar", "-xzf", archive, "-C", temporary])
    cpSync(join(temporary, `node-v${nodeVersion}-darwin-${architecture}`), destination, { recursive: true })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function syncDirectory(source: string, destination: string, excludes: string[] = []): void {
  const args = ["rsync", "-a", "--delete", ...excludes.flatMap(pattern => ["--exclude", pattern]), `${source}/`, `${destination}/`]
  run(args)
}

/** Return the first source TypeScript path in a packaged first-party tree, if any. */
function firstSourceTypeScript(root: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Third-party dependencies may intentionally carry TypeScript source; the
    // shipping invariant applies only to our first-party package trees.
    if (entry.isDirectory() && entry.name === "node_modules") continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = firstSourceTypeScript(path)
      if (nested !== undefined) return nested
    } else if (entry.isFile()
      && !entry.name.endsWith(".d.ts")
      && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      return path
    }
  }
  return undefined
}

/**
 * Reject an Anton candidate which cannot run the built Harness or which copied
 * readable first-party implementation TypeScript into its package directories.
 * Generated `.d.ts` declarations and third-party dependencies are allowed.
 */
function assertLibOnlyHarnessBundle(): void {
  const bundledHarness = join(resources, "deepseek-harness")
  const bundledContextPlugin = join(resources, "c0ntext", "deepseek-harness-plugin")
  const required = [
    join(resources, "node", "bin", "node"),
    join(bundledHarness, "apps", "cli", "lib", "bin.js"),
    join(bundledContextPlugin, "lib", "index.js"),
    join(bundledContextPlugin, "lib", "client.js"),
  ]
  for (const path of required) {
    if (!existsSync(path)) throw new Error(`Anton package is missing required built runtime file: ${path}`)
  }
  for (const root of [join(bundledHarness, "apps"), join(bundledHarness, "packages"), bundledContextPlugin]) {
    const source = firstSourceTypeScript(root)
    if (source !== undefined) throw new Error(`Anton package must not contain first-party TypeScript source: ${source}`)
  }
}

/** Render macos/AppIcon.png into the multi-resolution .icns the bundle's Info.plist names. */
function appIcon(destination: string): void {
  const source = join(bridgeRoot, "macos", "AppIcon.png")
  const temporary = mkdtempSync(join(tmpdir(), "anton-icon-"))
  const iconset = join(temporary, "Anton.iconset")
  mkdirSync(iconset)
  try {
    for (const points of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = points * scale
        const name = scale === 1 ? `icon_${points}x${points}.png` : `icon_${points}x${points}@2x.png`
        run(["sips", "-z", String(pixels), String(pixels), source, "--out", join(iconset, name)])
      }
    }
    run(["iconutil", "-c", "icns", iconset, "-o", destination])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.platform !== "darwin") throw new Error("The macOS app bundle can only be built on macOS")
if (!existsSync(harnessRoot) || !existsSync(contextRoot)) throw new Error("Expected sibling deepseek-harness and c0ntext directories")

rmSync(appRoot, { recursive: true, force: true })
mkdirSync(join(resources, "bin"), { recursive: true })
mkdirSync(macOS, { recursive: true })

run(["bun", "build", "--compile", "--outfile", join(resources, "bin", "anton-bridge"), "src/index.ts"], bridgeRoot)
bundledNode(join(resources, "node"))
cpSync(join(bridgeRoot, "macos", "Info.plist"), join(contents, "Info.plist"))
appIcon(join(resources, "Anton.icns"))
run(["swiftc", "-parse-as-library", "-framework", "Cocoa", join(bridgeRoot, "macos", "AntonApp.swift"), "-o", join(macOS, "Anton")])

// Harness runs from its built lib/ tree. The workspace's own src/ dirs and
// every *.ts/*.tsx file are excluded so the bundle carries no readable
// TypeScript; node_modules dependencies keep their src/ (some, like koffi,
// ship their runtime JS there). Stale bun-build bridge artifacts are dead
// weight. Keep node_modules: workspace symlinks remain valid because the
// whole tree is copied together.
syncDirectory(harnessRoot, join(resources, "deepseek-harness"), ["/.git", "/dist", "/.turbo", "packages/*/*/src", "apps/*/src", "*.ts", "*.tsx", "*.map", "*.bun-build", "apps/anton-bridge/dist"])
// Runtime memory is user data, never an application asset. Docker will build
// the engine images from the remaining compose source on first local start.
// The c0ntext plugin ships its built lib/ (readable TypeScript excluded).
syncDirectory(contextRoot, join(resources, "c0ntext"), ["/.git", "/runtime", "__pycache__", "*.pyc", "*.ts", "*.tsx", "*.map", "deepseek-harness-plugin/src"])
// Fail the candidate build rather than shipping a bridge which can listen but
// cannot launch Harness because its native c0ntext plugin is absent.
const bundledPluginManifest = join(resources, "c0ntext", "deepseek-harness-plugin", "package.json")
if (!existsSync(bundledPluginManifest)) {
  throw new Error(`Bundled c0ntext plugin was not copied to ${bundledPluginManifest}`)
}
assertLibOnlyHarnessBundle()

run(["codesign", "--force", "--sign", "-", join(resources, "bin", "anton-bridge")])
run(["codesign", "--force", "--sign", "-", join(resources, "node", "bin", "node")])
run(["codesign", "--force", "--sign", "-", appRoot])

console.log(`Built ${appRoot}`)
console.log(`Size: use du -sh ${appRoot}`)
