"""Lock: ruff's rule set and scope are properties of this repo (#132).

This package was the only Python package in the portfolio with no
`[tool.ruff.lint]` block, so it inherited whatever ruff's *default* rule
selection happened to be on the day CI ran. The `dev` extra pins
`ruff>=0.7` (unbounded) and the `filesystem-sandbox-py` CI job runs
`ruff check .` + `ruff format --check .`, so when 0.16.1 widened the
defaults, a tree that was clean under 0.15.13 produced 8 errors with
nothing here changed — a latent red waiting on the next push.

Two locks, matching the six sibling repos swept on 2026-07-31:

- the explicit `select`/`ignore` list, so what CI enforces is decided here
  and not by ruff's release calendar;
- `extend-exclude = ["*.md"]`, because 0.16.1 also extended `ruff format`
  to Python code blocks inside Markdown. That one is still latent here
  (this package's README happens to already be formatted), which is
  exactly why it needs pinning rather than luck.

Deliberately asserts on the config rather than shelling out to ruff: the
point is that the intent is recorded and can't be dropped by accident, and
the assertion must hold on any ruff version — including ones predating
these changes, which is the version skew that let this land in the first
place.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

# The list every other Python package in the portfolio declares. Kept
# verbatim so a drift in any one repo is visible as a diff here.
_PORTFOLIO_SELECT = ["E", "F", "I", "B", "UP", "SIM", "PT"]


def _ruff_config() -> dict:
    return tomllib.loads(_PYPROJECT.read_text(encoding="utf-8"))["tool"]["ruff"]


def test_lint_rule_set_is_pinned_not_inherited() -> None:
    lint = _ruff_config().get("lint")
    assert lint is not None, (
        "pyproject.toml must declare [tool.ruff.lint]. Without it this "
        "package inherits ruff's default rule selection, which changes "
        "between releases — ruff 0.16.1 turned a clean tree into 8 errors "
        "with no repo-side change (#132)."
    )
    assert lint.get("select") == _PORTFOLIO_SELECT, (
        "the selected rule set must stay in sync with the rest of the "
        f"portfolio ({_PORTFOLIO_SELECT}); every other Python package "
        "declares this exact list."
    )
    assert "E501" in lint.get("ignore", []), (
        "E501 is ignored portfolio-wide — line length is enforced by the formatter, not the linter."
    )


def test_markdown_is_excluded_from_ruff() -> None:
    excluded = _ruff_config().get("extend-exclude", [])
    assert "*.md" in excluded, (
        "ruff must not format Python code blocks inside Markdown. Restore "
        '`extend-exclude = ["*.md"]` under [tool.ruff] in pyproject.toml — '
        "without it, ruff >=0.16.1 rewrites committed prose."
    )


def test_committed_markdown_exists_to_protect() -> None:
    # Guards against the exclusion quietly becoming a no-op: if the package
    # ever stops carrying Markdown, the lock above passes vacuously and the
    # next person has no signal that it still matters. This package's README
    # documents the threat model and carries Python client-wiring blocks.
    assert (_PYPROJECT.parent / "README.md").is_file()


def test_self_referencing_annotations_stay_resolvable() -> None:
    # `UP` is in the selected set, and UP037 wants the quotes off
    # `Sandbox.create`'s `-> "Sandbox"` return annotation. That is only safe
    # because sandbox.py carries `from __future__ import annotations`;
    # without it, CI's Python 3.11/3.12 raise `NameError: name 'Sandbox' is
    # not defined` while evaluating the class body — the class is not bound
    # yet. (Python 3.14 masks this via PEP 649, so a newer local interpreter
    # will not reproduce it.) Lock the import that makes the unquoted form
    # legal, and that the annotation still resolves at runtime.
    import typing

    from filesystem_sandbox import sandbox as sandbox_module

    src = Path(sandbox_module.__file__).read_text(encoding="utf-8")
    assert "from __future__ import annotations" in src, (
        "sandbox.py's unquoted self-referencing return annotation depends on "
        "PEP 563 deferred evaluation on Python 3.11/3.12."
    )
    hints = typing.get_type_hints(sandbox_module.Sandbox.create.__func__)
    assert hints["return"] is sandbox_module.Sandbox
