"""Suite-wide fixtures."""

from __future__ import annotations

# Autouse, session-scoped: fails the session if any test rewrote a committed
# file (portfolio-ops#79). Imported, not defined here, so its self-test can
# load the same file as an inner session's conftest.
from tests._committed_files_guard import committed_files_are_untouched  # noqa: F401
