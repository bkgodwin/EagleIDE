"""Versioned password hashing, including legacy long passphrases."""

import hashlib
import bcrypt

ADMIN_HASH_SCHEME = "bcrypt-sha256-hex-v1"


def hash_password(password):
    material = hashlib.sha256(password.encode("utf-8")).hexdigest().encode("ascii")
    return bcrypt.hashpw(material, bcrypt.gensalt()).decode("ascii")


def verify_password(password, password_hash, scheme):
    if scheme == ADMIN_HASH_SCHEME:
        material = hashlib.sha256(password.encode("utf-8")).hexdigest().encode("ascii")
    elif scheme == "bcrypt":
        material = password.encode("utf-8")
    else:
        return False
    try:
        return bcrypt.checkpw(material, password_hash.encode("ascii"))
    except (ValueError, UnicodeError):
        return False


# Explicit names keep administrator migration callers clear.
hash_admin_password = hash_password
verify_admin_password = verify_password
