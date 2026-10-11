"""Bounded, streaming CSV pages and optimistic cell edits for workspaces."""
from __future__ import annotations

import csv
import io
import os
import tempfile
from threading import RLock

from flask import jsonify, request

_locks = [RLock() for _ in range(32)]
PAGE_ROWS = 50
PAGE_COLUMNS = 40
MAX_RECORD_CHARS = 256 * 1024


def version(path):
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def records(handle):
    # readline is bounded even for a single enormous cell or quoted record.
    consumed = 0
    def lines():
        nonlocal consumed
        while True:
            line = handle.readline(MAX_RECORD_CHARS + 1)
            if not line:
                return
            consumed += len(line)
            if consumed > MAX_RECORD_CHARS:
                raise ValueError("A CSV record exceeds the 256 KB viewer limit. Download it to edit locally.")
            yield line
    reader = csv.reader(lines(), strict=True)
    while True:
        offset = handle.tell()
        consumed = 0
        try:
            row = next(reader)
        except StopIteration:
            return
        yield offset, row


def register(app, eagle):
    def target_for_request(data):
        user = eagle._require_user_for_files(request)
        if not user:
            return None, (jsonify(ok=False, error="Authentication required"), 401)
        root = eagle._get_user_dir(user["email"])
        target = eagle._validate_workspace_path(root, str(data.get("path") or ""))
        if not target or not target.is_file() or target.suffix.lower() != ".csv":
            return None, (jsonify(ok=False, error="CSV file not found"), 404)
        return (root, target), None

    @app.get("/api/files/csv-page")
    def csv_page():
        resolved, error = target_for_request(request.args)
        if error:
            return error
        _, target = resolved
        try:
            cursor = int(request.args.get("cursor", 0))
            column = int(request.args.get("column", 0))
            if cursor < 0 or column < 0 or column > 10000:
                raise ValueError("Invalid page")
            with _locks[hash(str(target)) % len(_locks)], target.open("r", encoding="utf-8-sig", newline="") as handle:
                current = version(target)
                if request.args.get("version") and request.args["version"] != current:
                    return jsonify(ok=False, error="CSV changed. Reopen the file to load its latest contents."), 409
                iterator = records(handle)
                header_offset, header = next(iterator, (0, [""]))
                first = handle.tell()
                if cursor and (cursor < first or cursor > target.stat().st_size):
                    raise ValueError("Invalid page")
                handle.seek(cursor or first)
                rows = []
                response_chars = 0
                columns = len(header)
                for offset, row in records(handle):
                    columns = max(columns, len(row))
                    rows.append({"offset": offset, "cells": row[column:column + PAGE_COLUMNS]})
                    response_chars += sum(len(cell) for cell in row[column:column + PAGE_COLUMNS])
                    if len(rows) >= PAGE_ROWS or response_chars >= 512 * 1024:
                        break
                next_cursor = handle.tell()
                more = bool(handle.read(1))
                return jsonify(ok=True, kind="csv", version=current, headerOffset=header_offset,
                               header=header[column:column + PAGE_COLUMNS], rows=rows, column=column,
                               columns=columns, nextCursor=next_cursor if more else None,
                               size=target.stat().st_size)
        except (ValueError, csv.Error, UnicodeError) as exc:
            return jsonify(ok=False, error=str(exc)), 422
        except OSError:
            return jsonify(ok=False, error="Could not read CSV"), 500

    @app.post("/api/files/csv-edit")
    def csv_edit():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid CSV edits"), 400
        resolved, error = target_for_request(data)
        if error:
            return error
        root, target = resolved
        changes = data.get("changes", [])
        append = data.get("appendRow", False)
        if type(append) is not bool:
            return jsonify(ok=False, error="Invalid append option"), 400
        if not isinstance(changes, list) or len(changes) > (PAGE_ROWS + 1) * PAGE_COLUMNS:
            return jsonify(ok=False, error="Too many CSV edits"), 400
        edits = {}
        try:
            for change in changes:
                offset, column, value = change["offset"], change["column"], change["value"]
                if type(offset) is not int or type(column) is not int or offset < 0 or not 0 <= column <= 10000 \
                        or not isinstance(value, str) or len(value) > 32768:
                    raise ValueError("Invalid CSV cell")
                edits.setdefault(offset, {})[column] = value
        except (KeyError, TypeError, ValueError) as exc:
            return jsonify(ok=False, error=str(exc)), 400
        temporary = None
        try:
            with _locks[hash(str(target)) % len(_locks)]:
                if data.get("version") != version(target):
                    return jsonify(ok=False, error="CSV changed. Reopen the file before saving."), 409
                used = eagle._get_user_storage_used(root) - target.stat().st_size
                seen = set()
                offsets = {}
                wanted_offsets = data.get("offsets", [])
                if not isinstance(wanted_offsets, list) or len(wanted_offsets) > PAGE_ROWS + 2 or any(type(v) is not int or v < 0 for v in wanted_offsets):
                    return jsonify(ok=False, error="Invalid page offsets"), 400
                fd, temporary = tempfile.mkstemp(prefix=".csv-edit-", dir=target.parent)
                row_count = 0
                append_offset = None
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as output, \
                        target.open("r", encoding="utf-8-sig", newline="") as source:
                    def write_row(row):
                        if sum(len(cell) for cell in row) > MAX_RECORD_CHARS:
                            raise ValueError("Edited CSV record exceeds the 256 KB viewer limit")
                        buffer = io.StringIO(newline="")
                        csv.writer(buffer).writerow(row)
                        rendered = buffer.getvalue()
                        if len(rendered) > MAX_RECORD_CHARS:
                            raise ValueError("Edited CSV record exceeds the 256 KB viewer limit")
                        output.write(rendered)
                        if used + output.tell() > eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024:
                            raise ValueError("Workspace storage limit exceeded")
                    for offset, row in records(source):
                        row_count += 1
                        if offset in wanted_offsets:
                            offsets[offset] = output.tell()
                        if offset in edits:
                            seen.add(offset)
                            for column, value in edits[offset].items():
                                row.extend([""] * max(0, column + 1 - len(row)))
                                row[column] = value
                        write_row(row)
                    offsets[source.tell()] = output.tell()
                    if not source.tell() and 0 in edits:
                        row = []
                        for column, value in edits[0].items():
                            row.extend([""] * max(0, column + 1 - len(row)))
                            row[column] = value
                        write_row(row)
                        seen.add(0)
                        row_count = 1
                    if seen != set(edits):
                        raise ValueError("CSV row changed. Reopen the file before saving.")
                    if append:
                        if not row_count:
                            write_row([""])
                            row_count = 1
                        append_offset = output.tell()
                        row_count += 1
                        write_row([""])
                size = os.path.getsize(temporary)
                if used + size > eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024:
                    return jsonify(ok=False, error="Workspace storage limit exceeded"), 413
                if data.get("version") != version(target):
                    return jsonify(ok=False, error="CSV changed while saving. Reopen it before saving."), 409
                os.replace(temporary, target)
                temporary = None
                eagle._invalidate_workspace_tree_cache(root)
                return jsonify(ok=True, version=version(target), offsets=offsets,
                               appendOffset=append_offset, appendRowNumber=row_count, size=size)
        except (ValueError, csv.Error, UnicodeError) as exc:
            return jsonify(ok=False, error=str(exc)), 422
        except OSError:
            return jsonify(ok=False, error="Could not save CSV"), 500
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
