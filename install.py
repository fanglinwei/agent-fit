#!/usr/bin/env python3
"""Compatibility entry: delegate the original install arguments to the npm CLI."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent', choices=['codex'], default='codex')
    parser.add_argument('--codex-home')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        print('需要 Node.js 22+；请先安装 Node，然后运行 npm ci。', file=sys.stderr)
        return 1
    command = [node, str(Path(__file__).resolve().parent / 'bin/subagent-delegation.mjs'), 'setup', '--agent=codex']
    if args.codex_home is not None:
        command.append('--codex-home=' + args.codex_home)
    if args.dry_run:
        command.append('--dry-run')
    try:
        return subprocess.run(command, check=False).returncode
    except OSError:
        print('无法启动 Node CLI；请检查安装路径和权限。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
