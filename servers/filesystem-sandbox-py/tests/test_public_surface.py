"""Public-surface tests for ``filesystem_sandbox/__init__.py``.

The Python parity port's smallest-in-the-portfolio public surface: 4
names re-exported from one submodule (``sandbox``). The other three
submodules (``config``, ``server``, ``tools``) are intentionally
dotted-path / lazy-imported — the lazy import on ``server`` keeps the
primitive's tests stdlib-only (the ``mcp`` Python SDK is gated behind
the ``[server]`` extra).

Every other test in this suite imports submodules directly (``from
filesystem_sandbox.sandbox import Sandbox``), so silent renames or
accidental ``__all__`` drops in ``__init__.py`` don't fail any test —
but they break:

1. The package docstring's quoted "Library use" promise:
   ``from filesystem_sandbox import Sandbox, SandboxEscape``.
2. The README's quoted CLI invocation:
   ``python -m filesystem_sandbox.server`` (line 95).
3. The pyproject script entry-point:
   ``mcp-filesystem-sandbox-py = "filesystem_sandbox.server:main"``.

These four standalone + 2 parametrized tests lock the surface across
six orthogonal axes:

1. ``__version__`` is set to a semver-ish string.
2. Every name in ``__all__`` is bound on the package and non-None.
3. ``__all__`` agrees with the actual top-level relative ``from .X
   import …`` names (filter on ``level >= 1``).
4. The PACKAGE DOCSTRING's quoted ``from filesystem_sandbox import
   Sandbox, SandboxEscape`` resolves (novel axis: the README has no
   top-level Python quickstart imports — the contract lives in the
   package's own ``__init__.py`` docstring).
5. The README + pyproject's quoted dotted path
   ``filesystem_sandbox.server.main`` resolves to a callable (guards
   against the ``mcp-filesystem-sandbox-py`` CLI entry-point and
   ``python -m filesystem_sandbox.server`` invocation silently breaking).
6. One anchor per re-exported submodule (just ``sandbox`` — 1 anchor).

Eighth (and final portable) strike of the portfolio-wide public-surface
hygiene pattern. First variant in the pattern to lock a *package
docstring*'s quoted imports rather than a README's.
"""

from __future__ import annotations

import ast
import importlib
import re
from pathlib import Path

import pytest

import filesystem_sandbox

_INIT_PATH = Path(filesystem_sandbox.__file__)
_SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:[-+].+)?$")

# Package docstring (line 10 in __init__.py) quotes these two names
# as importable directly from the top level.
PACKAGE_DOCSTRING_NAMES = ("Sandbox", "SandboxEscape")

# README (line 95) and pyproject script entry-point both quote this
# dotted path:
#   pyproject: mcp-filesystem-sandbox-py = "filesystem_sandbox.server:main"
#   README:    python -m filesystem_sandbox.server
README_DOTTED_PATHS = (("filesystem_sandbox.server", "main"),)

# Anchor names that prove each re-exported submodule survived.
# ``config``/``server``/``tools`` are intentionally NOT in this map —
# they are accessed via dotted path / lazy-imported.
SUBMODULE_ANCHORS = {
    "sandbox": "Sandbox",
}


def _parse_init_relative_imports() -> set[str]:
    """Return the set of names imported into ``__init__.py`` via
    top-level relative ``from .X import (...)`` blocks."""
    tree = ast.parse(_INIT_PATH.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.level >= 1:
            for alias in node.names:
                names.add(alias.asname or alias.name)
    return names


def test_version_is_set_to_semver_ish_string() -> None:
    """``__version__`` is published; downstream importers and PyPI
    builds rely on it."""
    assert hasattr(filesystem_sandbox, "__version__"), (
        "filesystem_sandbox.__version__ is missing — packaging tools "
        "and downstream `filesystem_sandbox.__version__` lookups will "
        "break."
    )
    version = filesystem_sandbox.__version__
    assert isinstance(version, str), (
        f"filesystem_sandbox.__version__ should be a string, got "
        f"{type(version).__name__}: {version!r}."
    )
    assert version, "filesystem_sandbox.__version__ is an empty string."
    assert _SEMVER_PATTERN.match(version), (
        f"filesystem_sandbox.__version__ = {version!r} doesn't look "
        f"like semver (expected MAJOR.MINOR.PATCH[-prerelease][+build])."
    )


def test_all_names_are_bound_and_non_none() -> None:
    """Every name in ``__all__`` must be importable and non-None."""
    missing: list[str] = []
    none_valued: list[str] = []
    for name in filesystem_sandbox.__all__:
        if not hasattr(filesystem_sandbox, name):
            missing.append(name)
            continue
        if getattr(filesystem_sandbox, name) is None:
            none_valued.append(name)
    assert not missing, (
        f"filesystem_sandbox.__all__ advertises names that are not "
        f"bound on the package: {missing}. The most likely cause is "
        f"a re-import line was deleted from __init__.py but __all__ "
        f"wasn't updated."
    )
    assert not none_valued, (
        f"filesystem_sandbox.__all__ entries bound to None: "
        f"{none_valued}. A re-import probably resolved to a missing "
        f"submodule attribute."
    )


def test_all_matches_actual_top_level_imports() -> None:
    """``__all__`` should equal the set of top-level relative re-exports."""
    advertised = set(filesystem_sandbox.__all__)
    imported = _parse_init_relative_imports()
    only_imported = imported - advertised
    only_advertised = advertised - imported
    assert not only_imported, (
        f"Names imported into filesystem_sandbox/__init__.py but "
        f"missing from __all__: {sorted(only_imported)}. Add them to "
        f"__all__ or stop importing them at the top level."
    )
    assert not only_advertised, (
        f"Names in filesystem_sandbox.__all__ but not imported at the "
        f"top of __init__.py: {sorted(only_advertised)}. Add the "
        f"import or remove the __all__ entry."
    )


def test_package_docstring_imports_resolve() -> None:
    """Package docstring's quoted "Library use" imports must keep working.

    The package docstring literally quotes (line 10 in __init__.py)::

        from filesystem_sandbox import Sandbox, SandboxEscape

    Unlike the prior repos in this pattern series, this package's
    "Library use" lives in ``__init__.py``'s own docstring rather than
    in the README (which leads with the CLI invocation instead). Lock
    the docstring's promise so it can't silently drift from the actual
    exports.
    """
    missing = [n for n in PACKAGE_DOCSTRING_NAMES if not hasattr(filesystem_sandbox, n)]
    assert not missing, (
        f"filesystem_sandbox is missing names quoted in its own "
        f"docstring's `Library use` section: {missing}. Either restore "
        f"the exports or update the docstring at the top of __init__.py."
    )


@pytest.mark.parametrize(
    ("module_path", "attr"),
    README_DOTTED_PATHS,
    ids=[f"{m}.{a}" for m, a in README_DOTTED_PATHS],
)
def test_readme_dotted_path_resolves(module_path: str, attr: str) -> None:
    """README's CLI invocation and pyproject's script entry-point both
    require ``filesystem_sandbox.server.main`` to resolve to a callable.

    The README literally quotes (line 95)::

        MCP_FS_SANDBOX_ALLOWLIST=/tmp/scratch python -m filesystem_sandbox.server

    And pyproject.toml declares::

        [project.scripts]
        mcp-filesystem-sandbox-py = "filesystem_sandbox.server:main"

    If ``server.py`` is renamed or ``main`` is moved, both the README
    invocation and the CLI entry-point silently break.
    """
    module = importlib.import_module(module_path)
    assert hasattr(module, attr), (
        f"`{module_path}.{attr}` no longer resolves. The README quotes "
        f"the module by name (around line 95) and pyproject's "
        f"[project.scripts] table points to `{module_path}:{attr}`. "
        f"Either restore the export or update both the README and "
        f"pyproject.toml."
    )
    obj = getattr(module, attr)
    assert callable(obj), (
        f"`{module_path}.{attr}` is no longer callable (got "
        f"{type(obj).__name__}). Both the `python -m` invocation and "
        f"the `mcp-filesystem-sandbox-py` console script call it; the "
        f"lookup must return a callable."
    )


@pytest.mark.parametrize(
    ("submodule", "anchor"),
    sorted(SUBMODULE_ANCHORS.items()),
    ids=sorted(SUBMODULE_ANCHORS.keys()),
)
def test_submodule_anchor_re_exported(submodule: str, anchor: str) -> None:
    """One anchor per *re-exported* submodule survives at the top level.

    Only ``sandbox`` is in this map; ``config``/``server``/``tools``
    are intentionally dotted-path / lazy-imported and re-exporting
    them at the top level would expand the public surface (and force
    the ``mcp`` SDK into the primitive's test path).
    """
    assert hasattr(filesystem_sandbox, anchor), (
        f"`{anchor}` from `filesystem_sandbox.{submodule}` is no longer "
        f"re-exported at the top level. Did `{submodule}` move or get "
        f"renamed? Update `filesystem_sandbox/__init__.py` to re-export "
        f"from the new path."
    )
