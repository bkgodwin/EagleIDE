"""Explicit, atomic device-cookie key rotation after administrator hash migration.

Run with the server stopped and a private pre-update backup available. Never
prints key material. The server must be restarted to revoke in-memory tokens.
"""

import argparse
import json
import os
import re
from pathlib import Path
import uuid
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from credential_security import hash_admin_password, ADMIN_HASH_SCHEME
from cryptography.fernet import Fernet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--migrate-admin", action="store_true", help="atomically migrate a legacy encrypted administrator credential before rotation")
    parser.add_argument("--apply", action="store_true", help="replace the device-cookie key; default is a read-only preflight")
    args = parser.parse_args()
    root = args.root.resolve()
    config = json.loads((root / "config.txt").read_text(encoding="utf-8"))
    if not str(config.get("admin_email") or "").strip():
        raise SystemExit("Administrator email is missing; no configuration or key was changed.")
    target = Path(os.environ.get("EAGLEIDE_ADMIN_KEY_FILE", str(root / ".admin_key"))).expanduser().resolve()
    if args.migrate_admin and config.get("admin_password_encrypted"):
        password = Fernet(target.read_bytes()).decrypt(config["admin_password_encrypted"].encode()).decode("utf-8")
        if not args.apply:
            print("Legacy credential can be migrated. No configuration or key was changed.")
            return
        migrated = dict(config)
        migrated.pop("admin_password_encrypted", None)
        migrated.update(admin_password_hash=hash_admin_password(password), admin_password_scheme=ADMIN_HASH_SCHEME)
        temporary_config = root / (".config-" + uuid.uuid4().hex + ".tmp")
        try:
            descriptor = os.open(temporary_config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(migrated, output, indent=2)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_config, root / "config.txt")
        finally:
            temporary_config.unlink(missing_ok=True)
        config = migrated
    if (not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", str(config.get("admin_password_hash") or ""))
            or config.get("admin_password_encrypted")
            or config.get("admin_password_scheme", "bcrypt") not in {"bcrypt", ADMIN_HASH_SCHEME}):
        raise SystemExit("Migrate the administrator credential first, or pass --migrate-admin with a private backup available.")
    target = Path(os.environ.get("EAGLEIDE_ADMIN_KEY_FILE", str(root / ".admin_key"))).expanduser().resolve()
    if not args.apply:
        print("Preflight passed. Rotation will invalidate saved device sign-ins; account data and passwords are retained.")
        return
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(Fernet.generate_key())
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    print("Device key rotated. Restart the server; users must sign in again. No account data was deleted.")


if __name__ == "__main__":
    main()
