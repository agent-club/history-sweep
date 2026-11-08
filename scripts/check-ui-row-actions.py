"""Run the native row-action contract through the existing trusted UI hook runner."""
from pathlib import Path
import os
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent.parent
    command = ["node", str(root / "scripts/verify-ui-row-actions.mjs")]
    # The trusted runner has an exact command contract, so it cannot receive a
    # per-command environment prefix. Reuse an installed browser only when the
    # Playwright version's default executable is absent.
    if not os.environ.get("HISTORY_SWEEP_CHROMIUM"):
        probe = subprocess.run(
            ["node", "--input-type=module", "-e",
             "import {dependency} from './scripts/runtime.mjs'; console.log(dependency('playwright').chromium.executablePath());"],
            cwd=root, capture_output=True, text=True, check=False,
        )
        if probe.returncode == 0:
            expected = Path(probe.stdout.strip())
            if not expected.is_file():
                # Preserve the platform-specific executable suffix while looking
                # only within the same Playwright browser cache.
                revision = next((parent for parent in expected.parents
                                 if parent.name.startswith('chromium-')), None)
                if revision:
                    suffix = expected.relative_to(revision)
                    installed = [directory / suffix for directory in revision.parent.glob('chromium-*')
                                 if directory.name.removeprefix('chromium-').isdigit()
                                 and (directory / suffix).is_file()]
                    installed.sort(key=lambda path: int(path.relative_to(revision.parent).parts[0].split('-')[1]))
                    if installed:
                        command.extend(["--browser", str(installed[-1])])
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            check=False,
        )
    except OSError as error:
        print("Native row-action check could not start: " + str(error), file=sys.stderr)
        return 1
    return completed.returncode if 0 <= completed.returncode <= 255 else 1


if __name__ == "__main__":
    raise SystemExit(main())
