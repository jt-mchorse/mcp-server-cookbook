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

- id: D-008
  date: 2026-05-17
  decision: canonical_sdk_version_lives_in_docs_spec_version_md_single_markdown_source_of_truth_ci_script_enforces_conformance
  rationale: cookbook_per_server_independence_d_002_means_no_root_package_json_to_carry_a_shared_pin_doc_as_source_of_truth_makes_the_invariant_human_readable_and_reviewable_in_a_pr_check_script_is_dep_free_node_stdlib_so_ci_runs_without_an_install_step_offline_upstream_verification_avoids_ci_dns_flakes
  alternatives_rejected: [read_from_one_designated_server_package_json_and_broadcast_silos_decision_in_code_file_hostile_to_reviewers, per_server_declarations_with_ci_script_reconciling_no_single_owner_harder_to_bump, online_check_against_modelcontextprotocol_io_too_flaky_in_ci]
  reversibility: cheap
  related_issues: [6]
  superseded_by: null

- id: D-009
  date: 2026-05-18
  decision: internal_tools_bridge_uses_shell_free_spawn_with_allowlist_env_scrub_output_cap_timeout_structured_args_only
  rationale: defense_in_depth_against_arg_injection_and_secret_exfil_each_layer_pinned_by_a_regression_test_no_shell_means_metacharacters_are_literal_data_allowlist_means_path_search_cant_widen_the_attack_surface_env_passlist_means_host_secrets_dont_leak_into_child_output_cap_plus_timeout_means_runaway_cli_cant_oom_or_hang_the_server
  alternatives_rejected: [child_process_exec_shell_interprets_metacharacters_nonstarter, no_allowlist_bridge_becomes_generic_shell_equivalent_regardless_of_shell_false, no_env_scrub_node_spawn_inherits_process_env_secrets_leak_by_default, output_cap_only_stdout_chatty_stderr_can_still_oom]
  reversibility: cheap
  related_issues: [4]
  superseded_by: null
