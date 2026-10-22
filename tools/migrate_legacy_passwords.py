"""Hash dormant legacy passwords without changing account/profile data.

Stop the server and make a private backup before --apply. The default is a
read-only preflight. Accounts with conflicting alternate credentials are kept
unchanged and counted for administrator review; no identity is printed.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from credential_security import hash_password, verify_password, ADMIN_HASH_SCHEME


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = args.root.resolve() / "users.json"
    if not path.exists():
        print(json.dumps({"legacy": 0, "migrated": 0, "review": 0, "apply": args.apply}))
        return
    stat = path.stat()
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("users"), list) or any(not isinstance(user, dict) for user in data["users"]):
        raise SystemExit("Unexpected accounts file format; no data was changed.")
    counts = {"legacy": 0, "migrated": 0, "review": 0, "apply": args.apply}
    for user in data.get("users", []):
        if not isinstance(user, dict) or not isinstance(user.get("password"), str):
            continue
        counts["legacy"] += 1
        password = user["password"]
        existing = user.get("password_hash")
        if existing and not verify_password(password, existing, user.get("password_hash_scheme") or "bcrypt"):
            counts["review"] += 1
            continue
        if args.apply:
            if not existing:
                user["password_hash"] = hash_password(password)
                user["password_hash_scheme"] = ADMIN_HASH_SCHEME
            user.pop("password", None)
            counts["migrated"] += 1
    if args.apply and counts["migrated"]:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(data, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            if path.stat().st_mtime_ns != stat.st_mtime_ns:
                raise SystemExit("Accounts changed during migration; no replacement was made. Stop the server and retry.")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps(counts))
    return int(bool(counts["review"]))


if __name__ == "__main__":
    raise SystemExit(main())
