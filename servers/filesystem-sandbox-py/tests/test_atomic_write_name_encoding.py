"""The temp-name byte budget is measured in the bytes the filesystem sees (#160).

`_cap_base_for_temp` exists so a destination basename near NAME_MAX does not
overflow the limit once the temp affixes are prepended (#96). Its docstring
used to promise "UTF-8 bytes", and the budget being enforced is NAME_MAX, which
limits the bytes handed to the *kernel* — `os.fsencode`, i.e.
`sys.getfilesystemencoding()` with `sys.getfilesystemencodeerrors()`. Those are
the same number for every name that is valid UTF-8, and a different thing
entirely for the rest, because strict `str.encode("utf-8")` *raises* on a lone
surrogate instead of counting it.

That broke the property the TS twin states outright: "the atomic helper must
accept every name the filesystem does (#96)". `capBaseForTemp` measures with
`Buffer.byteLength(base, "utf8")`, which never throws.

**The range is narrower than "any lone surrogate", and getting it wrong makes
the test vacuous.** `surrogateescape` only round-trips U+DC80..U+DCFF — the
codepoints it manufactures for raw bytes 0x80..0xFF — so only those name
something the kernel can hold. `U+D800` has no `os.fsencode` representation
either, so refusing it is correct both before and after the fix, and a test
written against it would pass identically either way. Both ranges are in the
table below, with different expectations, so the distinction is pinned rather
than assumed.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from filesystem_sandbox import atomic_write as aw_mod
from filesystem_sandbox.atomic_write import (
    MAX_TEMP_BASE_BYTES,
    _cap_base_for_temp,
    atomic_write_bytes,
)
from filesystem_sandbox.sandbox import Sandbox
from filesystem_sandbox.server import _dispatch_tool
from filesystem_sandbox.tools import ToolDeps

# What `surrogateescape` produces for the raw byte 0xFF: a name the kernel can
# hold. Built from its codepoint rather than written literally so the character
# cannot be mangled by an editor or a copy-paste round trip.
ESCAPED_BYTE = chr(0xDCFF)

# Outside the surrogateescape image. No filesystem encoding at any layer, so
# refusing it is correct — this is the control that keeps the table honest.
UNPAIRED_HIGH = chr(0xD800)


def _fs_len(text: str) -> int:
    """The byte length the kernel sees. Never raises for a name it can hold."""
    return len(os.fsencode(text))


# ---------------------------------------------------------------------------
# The variant table. Axes: length (fits / overflows) x encoding class
# (pure ASCII / multibyte UTF-8 / surrogateescape-bearing / mixed).
# ---------------------------------------------------------------------------

NAME_VARIANTS = [
    ("ascii-short", "note.txt"),
    ("ascii-at-budget", "a" * MAX_TEMP_BASE_BYTES),
    ("ascii-long", "a" * 250),
    # "é" is 2 bytes in UTF-8, so 150 of them is 300 bytes: over budget in
    # bytes while well under it in characters.
    ("multibyte-short", "nöte.txt"),
    ("multibyte-long", "é" * 150),
    # Each escaped byte is exactly one byte under `os.fsencode` — the byte the
    # name actually came from.
    ("escaped-byte-short", "note" + ESCAPED_BYTE + ".txt"),
    ("escaped-byte-long", ESCAPED_BYTE * 250),
    ("mixed-long", "é" * 50 + ESCAPED_BYTE * 150),
    ("escaped-byte-only", ESCAPED_BYTE),
    ("mixed-at-boundary", "a" * (MAX_TEMP_BASE_BYTES - 1) + ESCAPED_BYTE),
]


@pytest.mark.parametrize(("label", "base"), NAME_VARIANTS, ids=[v[0] for v in NAME_VARIANTS])
def test_cap_base_for_temp_never_raises_and_stays_within_budget(label: str, base: str) -> None:
    """Every name the filesystem can hold gets a capped answer, not an exception.

    Strict-UTF-8 measurement raised `UnicodeEncodeError` for the
    surrogateescape-bearing rows before it could answer the length question at
    all — refusing names the kernel accepts, which is what the TS twin's
    comment says must not happen.
    """
    capped = _cap_base_for_temp(base)

    assert _fs_len(capped) <= MAX_TEMP_BASE_BYTES, f"{label}: over budget"
    assert capped == base[: len(capped)], (
        f"{label}: the capped name must be a character-boundary prefix of the "
        "original — trimming happens by character so no codepoint is split"
    )
    if _fs_len(base) <= MAX_TEMP_BASE_BYTES:
        assert capped == base, f"{label}: a name within budget must be returned unchanged"
    else:
        # Maximality: one more character would have gone over. Without this the
        # test would also pass for a cap that returns "" for everything.
        assert len(capped) < len(base)
        assert _fs_len(base[: len(capped) + 1]) > MAX_TEMP_BASE_BYTES, (
            f"{label}: the cap trimmed further than the budget required"
        )


def test_cap_base_for_temp_agrees_with_the_old_measurement_on_encodable_names() -> None:
    """Switching the measurement must not move the budget for names that worked.

    `os.fsencode` and `str.encode("utf-8")` return the same bytes for every
    string that is valid UTF-8, so every previously-passing name is unaffected;
    the change is confined to the names the old call refused outright.
    """
    for _label, base in NAME_VARIANTS:
        try:
            strict = len(base.encode("utf-8"))
        except UnicodeEncodeError:
            continue  # the population the old measurement could not count at all
        assert _fs_len(base) == strict


def test_name_bytes_counts_an_escaped_byte_as_one_byte() -> None:
    """`os.fsencode` round-trips the surrogateescape image back to raw bytes."""
    assert aw_mod._name_bytes("note" + ESCAPED_BYTE + ".txt") == len(b"note\xff.txt")


def test_an_unpaired_high_surrogate_is_out_of_scope_and_stays_that_way() -> None:
    """The control that keeps this suite from being vacuous.

    `U+D800` is not in the `surrogateescape` image, so it names nothing the
    kernel can hold and `os.fsencode` refuses it too. Refusing it is correct
    *and unchanged by this fix* — which is precisely why a test written against
    it would prove nothing. Pinned here so a future reader can see the
    population was split deliberately rather than by accident.
    """
    with pytest.raises(UnicodeEncodeError):
        os.fsencode("note" + UNPAIRED_HIGH + ".txt")
    with pytest.raises(UnicodeEncodeError):
        _cap_base_for_temp("note" + UNPAIRED_HIGH + ".txt")


def test_cap_base_for_temp_is_total_over_every_name_os_fsencode_accepts() -> None:
    """Parity with the TS twin's stated property, without shelling out to node.

    `capBaseForTemp` measures with `Buffer.byteLength(base, "utf8")`, which
    never throws — so the TS side's property is "total over its input domain".
    The Python side's domain is "names `os.fsencode` accepts", and this asserts
    it is total over exactly that, across every byte a POSIX name can carry.
    """
    for byte in range(0x80, 0x100):
        # 0x80..0xFF are exactly the bytes surrogateescape has to smuggle, and
        # it maps them to U+DC80..U+DCFF. Every one of them names something a
        # POSIX filesystem can hold, so every one must survive the cap.
        base = "f" + chr(0xDC00 + byte) + ".txt"
        assert os.fsencode(base) == b"f" + bytes([byte]) + b".txt"
        assert _cap_base_for_temp(base) == base


# ---------------------------------------------------------------------------
# The seams. The exception *class* is the contract every caller is written
# against, so that is what gets asserted.
# ---------------------------------------------------------------------------


def test_atomic_write_bytes_unencodable_target_name_fails_as_oserror_if_at_all(
    tmp_path: Path,
) -> None:
    """A destination name the filesystem cannot represent is an OS-level
    problem, and must surface as one.

    Deliberately not asserted as "succeeds" or as "raises": ext4 accepts any
    non-NUL byte in a name and the write goes through, while APFS validates
    UTF-8 and returns `EILSEQ`. Both are correct, and both are `OSError` or
    nothing — which is what a plain `open(..., "wb")` of the same target does,
    the exact comparison this helper's own comment makes.
    """
    target = tmp_path / ("note" + ESCAPED_BYTE + ".txt")

    try:
        atomic_write_bytes(target, b"hi")
    except UnicodeEncodeError as e:  # pragma: no cover - the bug this closes
        pytest.fail(
            "atomic_write_bytes raised UnicodeEncodeError for an unencodable "
            f"destination *name*: {e!r}. The payload was pure ASCII bytes."
        )
    except OSError:
        # The filesystem refused the name. Nothing was left behind.
        assert list(tmp_path.iterdir()) == []
        return

    assert target.read_bytes() == b"hi"
    assert [p.name for p in tmp_path.iterdir()] == [target.name]


def test_atomic_write_bytes_long_unencodable_target_name_is_capped_not_refused(
    tmp_path: Path,
) -> None:
    """The long-name and the unencodable-name axes compose.

    This is the row that needs both halves of the fix: the fast-path check has
    to survive the escaped byte to discover the name is over budget, and the
    trim loop has to survive it on every iteration.
    """
    target = tmp_path / (ESCAPED_BYTE * 250)

    try:
        atomic_write_bytes(target, b"x")
    except UnicodeEncodeError as e:  # pragma: no cover - the bug this closes
        pytest.fail(f"cap raised on a long unencodable name: {e!r}")
    except OSError:
        assert list(tmp_path.iterdir()) == []


def test_write_file_dispatch_no_longer_reports_a_bare_codec_error() -> None:
    """The road an MCP client actually takes.

    A lone surrogate is legal JSON escape syntax and `json.loads` decodes it,
    so the argument reaches the sandbox exactly as written here. Before the
    fix the client got back `'utf-8' codec can't encode character ...` — a
    complaint about this helper's internal measurement, on a call whose
    `content` was pure ASCII, naming neither the tool nor the path.

    Asserted as "the error is not a codec error" rather than a fixed outcome,
    because ext4 accepts the name (the write succeeds, `isError` false) and
    APFS refuses it with `EILSEQ` (`isError` true, message names the path).
    Both are honest answers; a codec complaint is not.
    """
    root = Path(tempfile.mkdtemp())
    deps = ToolDeps(sandbox=Sandbox.create([str(root)]), read_only=False, max_bytes=100_000)
    name = json.loads('"note\\udcff.txt"')
    assert name == "note" + ESCAPED_BYTE + ".txt", "the JSON road must yield the same string"

    text, is_error = _dispatch_tool("write_file", {"path": str(root / name), "content": "hi"}, deps)

    assert "codec can't encode" not in text, (
        f"the client must not be told its ASCII content is unencodable: {text!r}"
    )
    if not is_error:
        assert (root / name).read_bytes() == b"hi"
    else:
        assert "note" in text, f"a refusal must name the path it refused: {text!r}"
