"""Run the native row-action contract through the existing trusted UI hook runner."""
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parent.parent
    try:
        completed = subprocess.run(
            ["node", str(root / "scripts/verify-ui-row-actions.mjs")],
            cwd=root,
            check=False,
        )
    except OSError as error:
        print("Native row-action check could not start: " + str(error), file=sys.stderr)
        return 1
    return completed.returncode if 0 <= completed.returncode <= 255 else 1


if __name__ == "__main__":
    raise SystemExit(main())
