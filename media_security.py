"""Metadata-free image encoding without changing a project's image format."""

import io
from PIL import Image, ImageOps, ImageSequence

FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".gif": "GIF", ".webp": "WEBP"}


def _clean_image(payload, extension):
    expected = FORMATS[extension.lower()]
    with Image.open(io.BytesIO(payload)) as original:
        if original.format != expected or original.width * original.height > 25_000_000:
            raise ValueError("Image format or dimensions are invalid")
        if getattr(original, "n_frames", 1) > 500:
            raise ValueError("Image contains too many animation frames")
        frames, durations, pixels = [], [], 0
        loop = original.info.get("loop", 0)
        for frame in ImageSequence.Iterator(original):
            pixels += frame.width * frame.height
            if pixels > 100_000_000:
                raise ValueError("Image animation exceeds the decoding limit")
            frame.load()
            durations.append(max(0, int(frame.info.get("duration", 100))))
            image = ImageOps.exif_transpose(frame).convert("RGB" if expected == "JPEG" else "RGBA")
            image.info.clear()
            frames.append(image)
        options = {"quality": 95} if expected == "JPEG" else {}
        if len(frames) > 1:
            options.update(save_all=True, append_images=frames[1:], duration=durations, loop=loop)
        output = io.BytesIO()
        frames[0].save(output, format=expected, **options)
        return output.getvalue()


class ImageValidationError(ValueError):
    pass


def clean_image(payload, extension):
    try:
        return _clean_image(payload, extension)
    except (OSError, ValueError, KeyError, Image.DecompressionBombError) as exc:
        raise ImageValidationError("Image could not be decoded safely") from exc
