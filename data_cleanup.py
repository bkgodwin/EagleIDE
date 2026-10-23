"""Opt-in administrative retention service; only named application data types."""
from contextlib import contextmanager
import math
from pathlib import Path
import re
import sqlite3
import threading
import time

from flask import jsonify, request
import classroom_features
import cleanup_accounts
from cleanup_files import CleanupRun, PolicyChanged, atomic_bytes, checked_path, children, read_json
from cleanup_store import CleanupStore, KINDS
import cleanup_wiki
import file_provenance


class AccountCleanupBusy(RuntimeError):
    pass


class CleanupManager:
    def __init__(self, eagle, root):
        self.eagle = eagle
        self.store = CleanupStore(root)
        self.gate = threading.RLock()
        self.run_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.scheduler = None
        self.active_run = None
        self.busy_accounts, self.busy_workspaces = set(), set()
        self.next_auto = time.time() + 60
        self.revision, self.policy = self.store.policy()

    def retention(self, kind):
        with self.gate:
            rule = self.policy["rules"][kind]
            return rule["days"] * 86400 if self.policy["enabled"] and rule["enabled"] else None

    def save(self, revision, policy):
        with self.gate:
            self.revision, self.policy = self.store.save_policy(revision, policy)
        if self.policy["enabled"]:
            self.start_scheduler()

    def start_scheduler(self):
        with self.gate:
            if self.scheduler and self.scheduler.is_alive(): return
            self.scheduler = threading.Thread(target=self._schedule, name="data-cleanup-scheduler", daemon=True)
            self.scheduler.start()

    def _schedule(self):
        while not self.stop_event.wait(60):
            if time.time() >= self.next_auto:
                try:
                    self.request_run("automatic")
                except (ValueError, OSError, sqlite3.Error):
                    pass
                self.next_auto = time.time() + 3600

    def close(self):
        self.stop_event.set()

    def remember_deleted(self, email):
        self.store.remember_deleted(email)

    def guard_account_save(self, data):
        with self.gate:
            if any(str(user.get("email") or "").strip().lower() in self.busy_accounts or
                   self.eagle._sanitize_email_for_path(str(user.get("email") or "").lower()) in self.busy_workspaces
                   for user in data.get("users", [])):
                raise AccountCleanupBusy("This deleted account's retained data is being cleaned. Retry account creation shortly.")

    def accounts(self):
        e = self.eagle
        # Fail closed on an absent/broken identity store. Never use the ordinary
        # permissive loader's empty fallback to infer that every user was deleted.
        raw = read_json(e.USERS_FILE)
        if not isinstance(raw, dict) or not isinstance(raw.get("users"), list) or any(
            not isinstance(row, dict) or not isinstance(row.get("email"), str) or not row["email"].strip() for row in raw["users"]):
            raise ValueError("A complete readable account store is required for deleted-user cleanup")
        emails = {row["email"].strip().lower() for row in raw["users"]} | {e.ADMIN_ACCOUNT_EMAIL.strip().lower()}
        workspace_keys = {e._sanitize_email_for_path(value) for row in raw["users"] for value in (row["email"], row["email"].lower())}
        workspace_keys.add(e._sanitize_email_for_path(e.ADMIN_ACCOUNT_EMAIL))
        workspace_keys.add(e._sanitize_email_for_path(e.ADMIN_ACCOUNT_EMAIL.lower()))
        storage_ids = {str(row.get("tool_storage_id") or "") for row in raw["users"]} | {"administrator"}
        return emails, workspace_keys, storage_ids

    @contextmanager
    def absent_account(self, email=None, workspace=None):
        e = self.eagle
        with e._users_lock:
            live, keys, _ = self.accounts()
            key = workspace or e._sanitize_email_for_path(email)
            if (email and email in live) or key in keys:
                yield False
                return
            with self.gate:
                if email: self.busy_accounts.add(email)
                self.busy_workspaces.add(key)
        try:
            yield True
        finally:
            with self.gate:
                if email: self.busy_accounts.discard(email)
                self.busy_workspaces.discard(key)

    def request_run(self, trigger="manual", *, synchronous=False, now=None):
        with self.gate:
            if not self.run_lock.acquire(blocking=False):
                return self.active_run
            try:
                revision, policy = self.store.policy()
                if not policy["enabled"] or not any(rule["enabled"] for rule in policy["rules"].values()):
                    raise ValueError("Enable cleanup and at least one saved data type first")
                identity = self.store.begin_run(trigger)
                self.active_run = identity
            except Exception:
                self.run_lock.release()
                raise
        run = CleanupRun(self, identity, revision, policy, time.time() if now is None else now)
        if synchronous:
            self._execute(run)
        else:
            threading.Thread(target=self._execute, args=(run,), name="data-cleanup-worker", daemon=True).start()
        return identity

    def _execute(self, run):
        state, message = "completed", ""
        e = self.eagle
        actions = {
            "workspace_trash": self._trash,
            "deleted_users": self._deleted,
            "wiki_trash": lambda r: cleanup_wiki.trash(r, e._wiki_store),
            "wiki_backups": lambda r: cleanup_wiki.archives(r, e._wiki_store),
            "wiki_recovery": lambda r: cleanup_wiki.recovery(r, e.app.extensions["eagle_wiki_history"]),
            "application_logs": self._logs,
            "wiki_analytics": lambda r: cleanup_wiki.analytics(r, e._wiki_store),
            "wiki_audit": lambda r: cleanup_wiki.audit(r, e.app.extensions["eagle_wiki_history"]),
            "temporary_files": self._temporary,
            "unused_backgrounds": self._backgrounds,
        }
        try:
            for kind, action in actions.items():
                if not run.policy["rules"][kind]["enabled"]: continue
                if self.stop_event.is_set(): raise PolicyChanged("Service stopping")
                try:
                    action(run)
                except PolicyChanged:
                    raise
                except (OSError, ValueError, sqlite3.Error, TypeError, KeyError) as exc:
                    run.note(kind, kind, "failed", type(exc).__name__)
                    state = "partial"
        except PolicyChanged as exc:
            state, message = "stopped", str(exc)
        except Exception:
            state, message = "failed", "Cleanup ledger or data unavailable; no further deletions attempted"
        finally:
            try:
                self.store.finish_run(run.id, state, message)
            finally:
                self.active_run = None
                self.run_lock.release()

    def _trash(self, run):
        e, kind = self.eagle, "workspace_trash"
        for workspace in children(e.USER_FILES_DIR):
            checked_path(e.USER_FILES_DIR, workspace)
            if not workspace.is_dir(): continue
            with e._trash_lock_for(workspace):
                trash = e._trash_dir(workspace)
                metadata_path = e._trash_metadata_path(workspace)
                raw = read_json(metadata_path, default={"items": {}})
                if not isinstance(raw, dict) or not isinstance(raw.get("items"), dict):
                    raise ValueError("Invalid Trash metadata; automatic deletion refused")
                items = raw["items"]
                paths = set(children(trash))
                # Finish old metadata/provenance cleanup after a crash or a
                # policy stop between unlink and metadata commit.
                for key, record in items.items():
                    parts = Path(key).parts
                    if len(parts) != 2 or parts[0] != e.TRASH_DIR_NAME or parts[1] in {".", ".."} or not isinstance(record, dict):
                        raise ValueError("Invalid Trash restore record")
                    paths.add(workspace / key)
                for path in sorted(paths):
                    checked_path(e.USER_FILES_DIR, path)
                    key = path.relative_to(workspace).as_posix()
                    record = items.get(key) or {}
                    deleted_at = cleanup_wiki.stamp(record.get("deleted_at"))
                    if not math.isfinite(deleted_at):
                        # Never trust a copied file's old mtime as deletion time.
                        deleted_at = self.store.observe("trash", str(path), run.now)
                    if deleted_at > run.cutoff(kind): continue
                    run.delete(kind, e.USER_FILES_DIR, path)
                    # Provenance files can contain pasted-source metadata too;
                    # their removal must have the same permanent file receipts.
                    provenance = e.USER_FILES_DIR.parent / "file_provenance"
                    with file_provenance.lock(workspace):
                        for record_path in children(file_provenance.directory(e, workspace)):
                            if record_path.suffix != ".json": continue
                            record = read_json(checked_path(provenance, record_path))
                            if record.get("path") == key or str(record.get("path", "")).startswith(key + "/"):
                                run.delete(kind, provenance, record_path)
                    items.pop(key, None)
                    if metadata_path.exists(): run.json(kind, e.USER_FILES_DIR, metadata_path, raw, 1)
                    self.store.forget_observation("trash", str(path))
            e._invalidate_workspace_tree_cache(workspace)

    def _deleted(self, run):
        e, kind = self.eagle, "deleted_users"
        live, keys, storage_ids = self.accounts()
        known = {row["email"] for row in self.store.deleted_accounts()}
        for email in cleanup_accounts.discover_emails(e) - live:
            if email not in known:
                self.store.remember_deleted(email, run.now, "first_observed_absent")
        for row in self.store.deleted_accounts():
            email = row["email"]
            if email in live:
                # Reuse is not proof that this is the original account. Forget
                # the old deadline; a later explicit deletion starts a new one.
                self.store.forget_account(email)
                continue
            if row["deleted"] > run.cutoff(kind): continue
            with self.absent_account(email=email) as absent:
                if absent:
                    cleanup_accounts.purge_account(run, email)
                    self.store.forget_account(email)
        # Older orphan files have no reversible identity/deletion timestamp.
        # Match only registered storage layouts, wait a fresh grace period and
        # recheck current ownership immediately before cleanup.
        targets = [(e.USER_FILES_DIR, path, path.name) for path in children(e.USER_FILES_DIR) if path.is_dir()]
        provenance = e.USER_FILES_DIR.parent / "file_provenance"
        targets += [(provenance, path, path.name) for path in children(provenance) if path.is_dir()]
        for directory in children(e.NOTEBOOKS_DIR):
            checked_path(e.NOTEBOOKS_DIR, directory)
            if directory.is_dir():
                targets += [(e.NOTEBOOKS_DIR, path, path.stem) for path in children(directory)
                            if path.suffix == ".json" and path.name != "prompts.json" and not path.name.startswith(".")]
        for root, path, key in targets:
            checked_path(root, path)
            if key in keys:
                self.store.forget_observation("orphan", str(path)); continue
            first = self.store.observe("orphan", str(path), run.now)
            if first <= run.cutoff(kind):
                with self.absent_account(workspace=key) as absent:
                    if absent:
                        run.delete(kind, root, path)
                        self.store.forget_observation("orphan", str(path))
        network = e.app.extensions["network_store"]
        with network._lock:
            live_hashes = {network._user_key(email) for email in live}
            paths = children(network.users_dir)
            for directory in children(network.progress_dir):
                checked_path(network.progress_dir, directory)
                if directory.is_dir():
                    for lab in children(directory):
                        checked_path(network.progress_dir, lab)
                        if lab.is_dir(): paths += children(lab)
            for path in paths:
                if not re.fullmatch(r"[a-f0-9]{64}\.json", path.name): continue
                if path.stem in live_hashes:
                    self.store.forget_observation("network", str(path)); continue
                first = self.store.observe("network", str(path), run.now)
                if first <= run.cutoff(kind):
                    # Serialize this short single-file operation with account
                    # registration, which changes the authoritative hash set.
                    with e._users_lock:
                        if path.stem not in {network._user_key(email) for email in self.accounts()[0]}:
                            run.delete(kind, network.base_dir, path)
                            self.store.forget_observation("network", str(path))
        storage = e._external_tools.storage
        if storage.root.exists():
            with storage.lock, storage._connect() as db:
                orphans = [row[0] for row in db.execute("SELECT id FROM accounts") if row[0] not in storage_ids]
            for identity in orphans:
                first = self.store.observe("tool-account", identity, run.now)
                if first <= run.cutoff(kind):
                    with e._users_lock, storage.lock:
                        if identity in self.accounts()[2]: continue
                        with storage._connect() as db:
                            uploads = [row[0] for row in db.execute("SELECT id FROM uploads WHERE account=?", (identity,))]
                        for upload in uploads: run.delete(kind, storage.root, storage._spool(upload))
                        run.change(kind, str(storage.root / "catalog.sqlite3") + "#" + identity, "prune_records",
                                   lambda: storage.delete_account(identity), records=1)
                        self.store.forget_observation("tool-account", identity)

    def _logs(self, run):
        e, kind, cutoff = self.eagle, "application_logs", run.cutoff("application_logs")
        with e._server_log_lock:
            path = e.APP_LOG_FILE
            for rotated in path.parent.glob(path.name + ".[1-5]"):
                checked_path(path.parent, rotated)
                if rotated.stat().st_mtime <= cutoff: run.delete(kind, path.parent, rotated)
            if path.exists():
                checked_path(path.parent, path)
                if path.stat().st_size > 50 * 1024 * 1024: raise ValueError("Log exceeds cleanup read limit")
                lines = path.read_bytes().splitlines(keepends=True)
                kept = [line for line in lines if cleanup_wiki.stamp(line[:19].decode("ascii", "replace"), local=True) > cutoff]
                if len(kept) != len(lines):
                    encoded = b"".join(kept)
                    run.change(kind, path, "prune_log_lines", lambda: atomic_bytes(path, encoded),
                               size=max(0, path.stat().st_size - len(encoded)), records=len(lines) - len(kept))
        for path, lock in ((e.SIGN_IN_EVENTS_FILE, e._server_health_lock), (e.SERVER_EVENTS_FILE, e._server_health_lock),
                           (classroom_features.CLASSROOM_EVENTS_FILE, classroom_features._classroom_events_lock)):
            with lock:
                rows = read_json(checked_path(path.parent, path), default=[])
                if not isinstance(rows, list): raise ValueError("Invalid event log")
                kept = [row for row in rows if cleanup_wiki.stamp(row.get("ts", row.get("timestamp")), local=True) > cutoff]
                if kept != rows: run.json(kind, path.parent, path, kept, len(rows) - len(kept))

    def _temporary(self, run):
        e, kind = self.eagle, "temporary_files"
        with e._wiki_store._write_lock:
            for path in children(e._wiki_store.staging_dir):
                checked_path(e._wiki_store.staging_dir, path)
                if path.is_file() and path.stat().st_mtime <= run.cutoff(kind):
                    # Metadata is created once, while chunks refresh the part
                    # file. Do not break a still-active, long-running upload.
                    if re.fullmatch(r"[a-f0-9]{32}\.(?:json|part)", path.name):
                        peer = path.with_suffix(".part" if path.suffix == ".json" else ".json")
                        checked_path(e._wiki_store.staging_dir, peer)
                        if peer.exists() and peer.stat().st_mtime > run.cutoff(kind): continue
                    run.delete(kind, e._wiki_store.staging_dir, path)
        # Runtime-created paths always belong to this server generation. Old
        # creation times alone are not proof that a long interactive run ended.
        for path in children(e.SANDBOX_DIR):
            checked_path(e.SANDBOX_DIR, path)
            if not path.name.startswith(("pyide_", "jside_", "html_runtime_")): continue
            if path.stat().st_mtime > run.cutoff(kind): continue
            with e._runner_lock:
                active = {Path(runner.sandbox_dir).resolve() for runner in e._runners.values() if runner.sandbox_dir}
            if path.resolve() in active or path.stat().st_ctime >= e.SERVER_START_EPOCH: continue
            run.delete(kind, e.SANDBOX_DIR, path)

    def _backgrounds(self, run):
        e, kind = self.eagle, "unused_backgrounds"
        with e._cfg_lock, e._classes_lock:
            # _cfg_lock is not reentrant; read its saved snapshot directly.
            cfg = read_json(e.PERSIST_FILE)
            classes = read_json(e.CLASSES_FILE)
            if not isinstance(cfg, dict) or not isinstance(classes, dict) or not isinstance(classes.get("classes"), list):
                raise ValueError("Background references unavailable")
            used = {str(cfg.get(key) or "") for key in e._BACKGROUND_CONFIG_KEYS.values()}
            used.update(str((row.get("settings") or {}).get("home_background_asset") or "") for row in classes["classes"])
            for path in children(e.BACKGROUND_ASSETS_DIR):
                if path.name not in used and re.fullmatch(r"[a-f0-9]{32}\.(?:jpg|png|webp)", path.name):
                    checked_path(e.BACKGROUND_ASSETS_DIR, path)
                    if path.stat().st_mtime <= run.cutoff(kind): run.delete(kind, e.BACKGROUND_ASSETS_DIR, path)


def register(app, eagle, manager):
    @app.errorhandler(AccountCleanupBusy)
    def account_busy(error):
        return jsonify(ok=False, error=str(error)), 409

    @app.get("/api/admin/cleanup")
    def cleanup_status():
        if not eagle._require_admin(request): return jsonify(ok=False, error="Admin token required"), 401
        try:
            before = int(request.args.get("before", 0))
            if not 0 <= before <= 2**63 - 1: raise ValueError()
            revision, policy = manager.store.policy()
            response = jsonify(ok=True, revision=revision, policy=policy, active_run=manager.active_run,
                next_automatic=manager.next_auto if policy["enabled"] else None,
                types=[{"id": key, "label": row[0], "default_days": row[1], "description": row[2]} for key, row in KINDS.items()],
                **manager.store.history(before))
            response.headers["Cache-Control"] = "private, no-store"
            return response
        except ValueError:
            return jsonify(ok=False, error="Invalid cleanup cursor or saved rules"), 400
        except (OSError, sqlite3.Error):
            return jsonify(ok=False, error="Cleanup storage is unavailable; no cleanup was started"), 503

    @app.post("/api/admin/cleanup/policy")
    def cleanup_save():
        if not eagle._require_admin(request): return jsonify(ok=False, error="Admin token required"), 401
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) != {"revision", "policy"}:
            return jsonify(ok=False, error="Provide a cleanup revision and policy"), 400
        try:
            manager.save(data["revision"], data["policy"])
            return jsonify(ok=True, revision=manager.revision, policy=manager.policy)
        except FileExistsError as exc:
            return jsonify(ok=False, error=str(exc)), 409
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except (OSError, sqlite3.Error):
            return jsonify(ok=False, error="Cleanup rules could not be saved"), 503

    @app.post("/api/admin/cleanup/run")
    def cleanup_run():
        if not eagle._require_admin(request): return jsonify(ok=False, error="Admin token required"), 401
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or data:
            return jsonify(ok=False, error="Clean now uses saved rules and takes no paths or retention overrides"), 400
        try:
            return jsonify(ok=True, run=manager.request_run()), 202
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 409
        except (OSError, sqlite3.Error):
            return jsonify(ok=False, error="The cleanup ledger is unavailable; nothing was deleted"), 503

    if manager.policy["enabled"]: manager.start_scheduler()
