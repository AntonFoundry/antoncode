#!/usr/bin/env python3
"""Apply the mechanical half of the Anton 0.1.x -> 0.2.2 package port.

Everything here is deterministic and reversible; real API drift is fixed by
hand afterwards. See implementation_plan.md for the full recipe.

Usage: port-package.py <package-path> [--face host|client]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

VENDOR = {"@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@deepseek-ai/cosmokit"}
ROOT = Path(__file__).resolve().parent.parent


def run(*args: str) -> str:
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, text=True).stdout


def port(pkg: str, face: str) -> None:
    path = ROOT / pkg
    run("git", "checkout", "anton-pre-merge", "--", pkg)
    run("git", "restore", "--staged", pkg)

    # Upstream deleted the invariants mechanism outright.
    for stale in (path / "src/invariant.ts", path / "tests/invariant.spec.ts"):
        if stale.exists():
            stale.unlink()

    manifest = path / "package.json"
    j = json.loads(manifest.read_text())
    j["version"] = "0.2.2-alpha.2"
    exports = j.get("exports") or {}
    exports.pop("./invariant", None)
    if exports:
        j["exports"] = exports
    if "files" in j:
        j["files"] = [f for f in j["files"] if "invariant" not in f]
    for section in ("dependencies", "peerDependencies", "devDependencies"):
        if section not in j:
            continue
        j[section] = {
            name: ("workspace:~" if name in VENDOR else spec if not spec.startswith("workspace:") else "workspace:*")
            for name, spec in j[section].items()
            if name != "@deepseek-ai/dsh-invariants"
        }
    manifest.write_text(json.dumps(j, indent=2) + "\n")

    tsconfig = path / "tsconfig.json"
    if tsconfig.exists():
        text = tsconfig.read_text()
        text = re.sub(r',?\s*\{\s*"path":\s*"[^"]*runtime-diagnostics/invariants"\s*\}', "", text)
        tsconfig.write_text(text)

    tsdown = path / "tsdown.config.ts"
    if tsdown.exists() and "invariant" in tsdown.read_text():
        print(f"  NOTE {pkg}: tsdown.config.ts still names invariant; collapse it by hand")

    aggregate = ROOT / ("tsconfig.client.json" if face == "client" else "tsconfig.host.json")
    text = aggregate.read_text()
    entry = f'    {{ "path": "./{pkg}" }},'
    if f'"./{pkg}"' not in text:
        marker = text.rindex('    { "path": "./packages/')
        end = text.index("\n", marker) + 1
        aggregate.write_text(text[:end] + entry + "\n" + text[end:])

    # tsconfig.base.json path aliases are a generated block; the generator owns
    # them and a hand-edit would be overwritten.
    print(f"  ported {pkg} ({j['name']}) — run `pnpm run gen-tsconfig-paths`")


if __name__ == "__main__":
    face = "client" if "--face" in sys.argv and sys.argv[sys.argv.index("--face") + 1] == "client" else "host"
    for target in [a for a in sys.argv[1:] if not a.startswith("--") and a != face]:
        port(target, face)
