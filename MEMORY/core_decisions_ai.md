# Core Decisions (AI-readable, YAML, append-only)
# Schema: see .skills/portfolio-memory/SKILL.md

- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null

- id: D-002
  date: 2026-05-15
  decision: per_server_subdirectories_no_shared_runtime_no_workspaces_root
  rationale: cookbook_not_framework_each_server_independently_readable_installable
  alternatives_rejected: [npm_workspaces_root, shared_runtime_package, monorepo_with_pnpm]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-003
  date: 2026-05-15
  decision: every_server_readme_leads_with_explicit_threat_model
  rationale: security_notes_mandatory_per_handoff_section_2_visibility_over_implicit_safety
  alternatives_rejected: [shared_security_doc, threat_model_optional]
  reversibility: cheap
  related_issues: [#1, #2]
  superseded_by: null

- id: D-004
  date: 2026-05-15
  decision: postgres_readonly_default_deny_writes_via_db_role_plus_session_plus_sql_parsing
  rationale: defense_in_depth_no_single_layer_sufficient_role_misconfig_or_clever_sql_must_not_succeed
  alternatives_rejected: [role_only, sql_parsing_only, prepared_statements_filter]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-005
  date: 2026-05-16
  decision: allowlist_resolved_at_construction_not_per_call
  rationale: cheaper_no_per_call_realpath_on_roots_locks_the_set_so_a_mid_run_symlink_change_on_a_root_cant_widen_the_sandbox
  alternatives_rejected: [resolve_on_every_call, watch_roots_for_changes_too_complex]
  reversibility: cheap
  related_issues: [#2]
  superseded_by: null

- id: D-006
  date: 2026-05-16
  decision: path_resolution_uses_fs_realpath_follows_symlinks_not_path_resolve_alone
  rationale: symlink_under_allowlist_pointing_outside_must_not_succeed_normalize_only_doesnt_dereference
  alternatives_rejected: [path_resolve_only, parse_symlinks_manually_brittle, refuse_all_symlinks_too_restrictive]
  reversibility: cheap
  related_issues: [#2]
  superseded_by: null

- id: D-007
  date: 2026-05-16
  decision: token_bearing_servers_redact_auth_at_error_boundaries_drop_request_body_from_error_context
  rationale: token_leak_via_tool_result_or_error_message_is_the_first_failure_mode_of_an_api_wrapper_redaction_at_the_client_layer_means_tool_layer_never_has_to_know_what_is_secret_request_body_can_contain_user_supplied_content_so_it_also_must_not_leak_through_errors
  alternatives_rejected: [redact_in_logger_only_does_not_cover_tool_results, redact_in_tool_layer_pushes_secret_awareness_outward, full_request_response_logging_for_debugging_unacceptable]
  reversibility: cheap
  related_issues: [#3]
  superseded_by: null
