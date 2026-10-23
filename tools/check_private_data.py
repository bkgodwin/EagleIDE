"""Reject runtime data and recognizable credentials in Git's tracked/staged tree.

Print paths and finding types only, never the matching bytes. This can run in CI
and as a pre-commit check; ignored files are checked if force-staged.
"""

import argparse
from pathlib import PurePosixPath
import re
import subprocess
import sys

# The public, cleaned root. Reject merging an old clone's ancestry back into
# the repository even if its current working tree contains no private files.
CLEAN_HISTORY_ROOT = "0e8206f26efe1953330a6a2256bff8a3aa911c3a"

PRIVATE_ROOTS = {
    "assignments", "assignment_submissions", "notebooks", "user_files", "sandboxes",
    "wiki_data", "wiki_backups", "network_data", "tool_data", "lesson_plans",
    "background_assets", "file_provenance", "logs", "cleanup_data",
}
PRIVATE_FILES = {
    "users.json", "classes.json", "skills.json", "config.txt", ".admin_key",
    "challenge_scores.json", "leaderboard.csv", "sign_in_events.json",
    "server_events.json", "server_state.json", "classroom_events.json", "classroom_signals.json",
}
SECRET_PATTERNS = {
    "private key": rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----",
    "GitHub token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b",
    "AWS access key": rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "Google API key": rb"\bAIza[0-9A-Za-z_-]{35}\b",
}
DATABASE_NAME = re.compile(r"\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$", re.IGNORECASE)


def inspect(path, data):
    parts = PurePosixPath(path).parts
    if not parts:
        return []
    name = parts[-1].lower()
    issues = []
    if DATABASE_NAME.search(name) or data.startswith(b"SQLite format 3\0"):
        issues.append("private database or sidecar")
    if parts[0] in PRIVATE_ROOTS or name in PRIVATE_FILES or name.endswith(".log") or name in {".env", "id_rsa", "id_ed25519"}:
        issues.append("private runtime path")
    if len(data) > 10 * 1024 * 1024:
        issues.append("oversized tracked file requires explicit review")
    for kind, pattern in SECRET_PATTERNS.items():
        if re.search(pattern, data):
            issues.append(kind)
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--history", action="store_true", help="require complete ancestry rooted only in the cleaned public history")
    args = parser.parse_args()
    if args.history:
        shallow = subprocess.check_output(["git", "rev-parse", "--is-shallow-repository"], text=True).strip()
        if shallow != "false":
            print("History verification needs a complete fetch, not a shallow checkout.", file=sys.stderr)
            return 1
        roots = subprocess.check_output(["git", "rev-list", "--max-parents=0", "HEAD"], text=True).splitlines()
        if set(roots) != {CLEAN_HISTORY_ROOT}:
            print("Unclean or unrelated root ancestry: transplant changes onto the cleaned main history; never merge an old clone.", file=sys.stderr)
            return 1
    command = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] if args.staged else ["git", "ls-files", "-z"]
    paths = subprocess.check_output(command).decode("utf-8").split("\0")
    failed = False
    for path in filter(None, paths):
        data = subprocess.check_output(["git", "show", ":" + path])
        for issue in inspect(path, data):
            print(f"{path}: {issue}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
