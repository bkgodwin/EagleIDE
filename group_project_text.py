"""Revisioned UTF-16 text operations for group projects.

Positive integers retain, negative integers delete, and strings insert. The
operation consumes its entire base document. The server orders concurrent
inserts before newer arrivals at the same position.
"""
import re

MAX_PARTS = 4096
MAX_CHANGE_BYTES = 96 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024


def length(value):
    return len(value.encode("utf-16-le")) // 2 if isinstance(value, str) else abs(value)


def append(parts, part):
    if not part:
        return
    last = parts[-1] if parts else None
    if (isinstance(part, str) and isinstance(last, str) or
            type(part) is int and type(last) is int and (part > 0) == (last > 0)):
        parts[-1] += part
    else:
        parts.append(part)


def validate(parts):
    if not isinstance(parts, list) or len(parts) > MAX_PARTS:
        raise ValueError("This edit contains too many changes")
    result = []
    inserted = 0
    for part in parts:
        if type(part) is int and 0 < abs(part) <= MAX_TEXT_BYTES:
            append(result, part)
        elif isinstance(part, str) and part and not re.search(r"[\x00\r]", part):
            inserted += len(part.encode("utf-8"))
            if inserted > MAX_CHANGE_BYTES:
                raise ValueError("This edit is too large. Paste it in smaller sections.")
            append(result, part)
        else:
            raise ValueError("Invalid text change")
    return result


def base_length(parts):
    return sum(abs(p) for p in parts if type(p) is int)


def transform(parts, other, *, before=False):
    """Rebase an operation over another one on the same base."""
    if base_length(parts) != base_length(other):
        raise ValueError("Text revisions do not match")
    result = []
    left, right = iter(parts), iter(other)
    a, b = next(left, 0), next(right, 0)
    while a or b:
        if isinstance(a, str) and (before or not isinstance(b, str)):
            append(result, a)
            a = next(left, 0)
        elif isinstance(b, str):
            append(result, length(b))
            b = next(right, 0)
        else:
            width = min(abs(a), abs(b))
            if b > 0:
                append(result, width if a > 0 else -width)
            a += -width if a > 0 else width
            b += -width if b > 0 else width
            a = a or next(left, 0)
            b = b or next(right, 0)
    return result


def apply(content, parts, spans, author):
    """Apply a validated operation and carry surviving authorship ranges forward."""
    source = content.encode("utf-16-le")
    if base_length(parts) * 2 != len(source):
        raise ValueError("Text revision does not match")
    result = []
    marks = []
    offset = output = index = 0

    def mark(start, end, person):
        if marks and marks[-1][1:] == [start, person]:
            marks[-1][1] = end
        else:
            marks.append([start, end, person])

    for part in parts:
        if isinstance(part, str):
            data = part.encode("utf-16-le")
            width = len(data) // 2
            if author is not None:
                mark(output, output + width, author)
            output += width
            result.append(data)
            continue
        end = offset + abs(part)
        if end * 2 < len(source) and 0xdc <= source[end * 2 + 1] <= 0xdf:
            raise ValueError("An edit cannot split a Unicode character")
        while index < len(spans) and spans[index][0] < end:
            start, stop, person = spans[index]
            if part > 0 and stop > offset:
                mark(output + max(start, offset) - offset, output + min(stop, end) - offset, person)
            if stop > end:
                break
            index += 1
        if part > 0:
            result.append(source[offset * 2:end * 2])
            output += part
        offset = end
    return b"".join(result).decode("utf-16-le"), marks
