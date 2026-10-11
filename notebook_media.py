"""Quota-counted notebook photos stored as ordinary, protected workspace files."""
from __future__ import annotations

import io
import re
import threading
import uuid
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

from flask import jsonify, request, send_file
from PIL import Image, ImageOps

MAX_PHOTO_PIXELS = 25_000_000
PHOTO_EDGE = 1920
_photo_lock = threading.Lock()


def image_path(eagle, email, relative):
    parts = PurePosixPath(str(relative)).parts
    if len(parts) != 2 or parts[0] != "images" or not eagle._valid_workspace_name(parts[1]):
        return None
    if Path(parts[1]).suffix.lower() not in eagle.IMAGE_EXTENSIONS:
        return None
    root = eagle._get_user_dir(email)
    if (root / "images").is_symlink():
        return None
    return eagle._validate_workspace_path(root, str(relative))


def photo_bytes(payload):
    with Image.open(io.BytesIO(payload)) as original:
        width, height = original.size
        if width <= 0 or height <= 0 or width * height > MAX_PHOTO_PIXELS:
            raise ValueError("Photo dimensions are too large")
        if original.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
            raise ValueError("Choose a JPEG, PNG, WebP, or GIF photo")
        image = ImageOps.exif_transpose(original)
        image.thumbnail((PHOTO_EDGE, PHOTO_EDGE))
        transparent = image.mode in {"RGBA", "LA"} or "transparency" in image.info
        image = image.convert("RGBA" if transparent else "RGB")
        image.info.clear()  # Do not retain camera EXIF/location or PNG metadata.
        output = io.BytesIO()
        image.save(output, format="PNG" if transparent else "JPEG", **({} if transparent else {"quality": 88}))
        return output.getvalue(), ".png" if transparent else ".jpg", image.size


class PhotoReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        if tag == "figure":
            path = dict(attrs).get("data-notebook-image")
            if path:
                self.paths.add(path)


def copy_notebook_photos(eagle, source_email, destination_email, html):
    """Shared tabs get independent photos; recipients never access another workspace."""
    parser = PhotoReferences()
    parser.feed(html)
    if not parser.paths or source_email.lower() == destination_email.lower():
        return
    with _photo_lock:
        root = eagle._get_user_dir(destination_email)
        root.mkdir(parents=True, exist_ok=True)
        photos = []
        for path in parser.paths:
            source = image_path(eagle, source_email, path)
            target = image_path(eagle, destination_email, path)
            if not source or not target or not source.is_file() or target.exists():
                continue
            if source.stat().st_size > eagle.MAX_UPLOAD_FILE_BYTES:
                raise ValueError("A shared photo exceeds the image size limit")
            photos.append((source, target))
        total = sum(source.stat().st_size for source, _ in photos)
        if eagle._get_user_storage_used(root) + total > eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024:
            raise ValueError("Recipient storage limit would be exceeded by these photos")
        if eagle._count_all_files_for_user(root) + len(photos) > eagle.MAX_FILES_PER_ACCOUNT or eagle._count_files_in_folder(root / "images") + len(photos) > eagle.MAX_FILES_PER_FOLDER:
            raise ValueError("Recipient file limit would be exceeded by these photos")
        saved = []
        staged = []
        copied_bytes = 0
        budget = eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024 - eagle._get_user_storage_used(root)
        try:
            for source, target in photos:
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.upload")
                staged.append(temp)
                file_bytes = 0
                with temp.open("xb") as handle:
                    with source.open("rb") as original:
                        while chunk := original.read(64 * 1024):
                            file_bytes += len(chunk)
                            copied_bytes += len(chunk)
                            if file_bytes > eagle.MAX_UPLOAD_FILE_BYTES or copied_bytes > budget:
                                raise ValueError("Shared photos exceed the recipient's storage or image size limit")
                            handle.write(chunk)
                temp.replace(target)
                saved.append(target)
            eagle._invalidate_workspace_tree_cache(root)
        except Exception:
            for target in saved + staged:
                target.unlink(missing_ok=True)
            raise


def register_notebook_media(eagle):
    @eagle.app.post("/api/notebook/images")
    def upload_photo():
        class_id = str(request.form.get("classId") or "").strip()
        actor, _ = eagle._notebook_actor_for_request(request, class_id)
        if not actor:
            return jsonify(ok=False, error="Notebook access required"), 403
        upload = request.files.get("image")
        if not upload:
            return jsonify(ok=False, error="Choose a photo"), 400
        payload = upload.stream.read(eagle.MAX_UPLOAD_FILE_BYTES + 1)
        if not payload or len(payload) > eagle.MAX_UPLOAD_FILE_BYTES:
            return jsonify(ok=False, error="Photo is empty or exceeds the 10 MB upload limit"), 413
        email = actor["email"].lower()
        with _photo_lock:
            try:
                data, extension, dimensions = photo_bytes(payload)
            except Exception:
                return jsonify(ok=False, error="This photo could not be decoded safely. Choose a JPEG, PNG, WebP, or GIF image."), 422
            root = eagle._get_user_dir(email)
            root.mkdir(parents=True, exist_ok=True)
            stem = re.sub(r"[^A-Za-z0-9_-]", "-", Path(str(upload.filename or "photo").replace("\\", "/")).stem)[:35].strip("-") or "photo"
            relative = f"images/{stem}-{uuid.uuid4().hex}{extension}"
            target = image_path(eagle, email, relative)
            if not target or ((root / "images").exists() and not (root / "images").is_dir()):
                return jsonify(ok=False, error="The images folder is unavailable"), 409
            if eagle._get_user_storage_used(root) + len(data) > eagle.USER_STORAGE_LIMIT_MB * 1024 * 1024:
                return jsonify(ok=False, error="Storage limit exceeded"), 413
            if eagle._count_all_files_for_user(root) >= eagle.MAX_FILES_PER_ACCOUNT or eagle._count_files_in_folder(target.parent) >= eagle.MAX_FILES_PER_FOLDER:
                return jsonify(ok=False, error="Workspace file limit reached"), 413
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.upload")
            try:
                with temp.open("xb") as handle:
                    handle.write(data)
                temp.replace(target)
            except Exception:
                temp.unlink(missing_ok=True)
                return jsonify(ok=False, error="Photo could not be saved"), 500
            eagle._invalidate_workspace_tree_cache(root)
        return jsonify(ok=True, path=relative, width=dimensions[0], height=dimensions[1], size=len(data), name=target.name)

    @eagle.app.get("/api/notebook/images")
    def read_photo():
        class_id = str(request.args.get("classId") or "").strip()
        email = str(request.args.get("studentEmail") or "").strip().lower()
        if email:
            teacher = eagle._require_teacher(request, allow_coteacher=True)
            cls = eagle._class_dashboard_access(teacher["email"], class_id) if teacher else None
            if not cls or email not in {str(s).lower() for s in cls.get("students", [])}:
                return jsonify(ok=False, error="Notebook access required"), 403
        else:
            actor, _ = eagle._notebook_actor_for_request(request, class_id)
            if not actor:
                return jsonify(ok=False, error="Notebook access required"), 403
            email = actor["email"].lower()
        target = image_path(eagle, email, request.args.get("path", ""))
        if not target or not target.is_file():
            return jsonify(ok=False, error="Photo not found"), 404
        try:
            if target.stat().st_size > eagle.MAX_UPLOAD_FILE_BYTES:
                return jsonify(ok=False, error="Photo exceeds the preview limit"), 413
            with Image.open(target) as image:
                if image.width * image.height > MAX_PHOTO_PIXELS:
                    raise ValueError("Photo dimensions exceed the preview limit")
                if image.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
                    raise ValueError("Unsupported image")
                content_type = Image.MIME[image.format]
                image.verify()
        except Exception:
            return jsonify(ok=False, error="Photo could not be decoded safely"), 422
        response = send_file(str(target), mimetype=content_type, conditional=True)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    eagle._copy_notebook_photos = lambda source, destination, html: copy_notebook_photos(eagle, source, destination, html)
