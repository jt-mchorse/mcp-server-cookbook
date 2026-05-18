# Session History (AI-readable, append-only)

Schema: see .skills/portfolio-memory/SKILL.md

---
session: 2026-05-15T10:15Z
duration_min: 90
issue: 1
focus: postgres_readonly_mcp_server
delta:
  files_added: 14
  files_changed: 3
  tests_added: 38
  test_pass_rate: "38/38"
context_for_next_session:
  - postgres_readonly_server_shipped_three_tools_describe_schema_run_select_sample_rows
  - sql_guard_layered_defense_strip_comments_strip_strings_keyword_allow_list_keyword_deny_list
  - sample_db_via_docker_compose_with_mcp_reader_role_grants_select_only
  - per_server_subdir_pattern_locked_d_002
  - threat_model_format_locked_d_003_filesystem_sandbox_2_must_match
decisions_made: [D-002, D-003, D-004]
followups: []
---


---
session: 2026-05-16T04:55Z
duration_min: 50
issue: 2
focus: filesystem_sandbox_mcp_server_with_allowlist
delta:
  files_added: 11
  files_changed: 2
  tests_added: 38
  test_pass_rate: "38/38 (server local) plus 38/38 unchanged postgres-readonly"
context_for_next_session:
  - new_server_at_servers_filesystem_sandbox_three_tools_list_directory_read_file_write_file
  - sandbox_class_resolves_input_via_fs_realpath_per_call_after_resolving_roots_at_construction_d_005_d_006
  - mandatory_allowlist_env_mcp_fs_sandbox_allowlist_no_permissive_default
  - read_only_via_env_mcp_fs_sandbox_read_only
  - max_bytes_via_env_mcp_fs_sandbox_max_bytes_default_1mb
  - tests_cover_path_traversal_symlinks_outside_null_bytes_control_chars_non_existent_paths_sibling_paths_starting_with_root_name
  - readme_leads_with_threat_model_section_per_d_003
  - cookbook_now_has_two_servers_postgres_readonly_and_filesystem_sandbox
  - issue_2_acceptance_allowlist_configurable_via_env_done_path_traversal_tests_pass_done_readme_documents_threat_model_done
decisions_made: [D-005, D-006]
followups: []
---

---
session: 2026-05-16T20:00Z
duration_min: 60
issue: 3
focus: github_gists_api_wrapper_mcp_server_with_token_auth
delta:
  files_added: 11
  files_changed: 2
  tests_added: 28
  test_pass_rate: "28/28 (server local) plus prior 38+38 unchanged"
context_for_next_session:
  - new_server_at_servers_github_gists_two_tools_get_gist_update_gist_file
  - auth_via_github_token_env_var_optional_for_get_gist_required_for_update_gist_file
  - client_redacts_authorization_header_drops_request_body_caps_error_text_body_at_200_chars_d_007
  - per_file_response_cap_100kb_truncated_true_content_null_above_cap
  - injectable_fetch_seam_for_hermetic_tests_no_real_github_calls_in_ci
  - ci_yml_added_github_gists_job_lint_typecheck_test_build
  - cookbook_now_has_three_servers_postgres_readonly_filesystem_sandbox_github_gists
  - filesystem_sandbox_ci_job_still_missing_filed_as_separate_followup_priority_low
  - issue_3_acceptance_auth_via_env_vars_never_logged_done_two_tools_wired_read_write_done_sample_client_run_documented_done
decisions_made: [D-007]
followups: []
---

---
session: 2026-05-17T23:35Z
duration_min: 35
issue: 6
focus: pin_mcp_spec_version_with_ci_drift_check
delta:
  files_added: 3  # docs/spec-version.md, tools/check-spec-version.mjs, tools/check-spec-version.test.mjs
  files_changed: 2  # .github/workflows/ci.yml, README.md
  tests_added: 14
  test_pass_rate: "14/14 (node:test stdlib)"
context_for_next_session:
  - docs_spec_version_md_is_single_source_of_truth_yaml_block_carries_sdk_package_sdk_version_mcp_spec_revision_url_notes
  - tools_check_spec_version_mjs_dep_free_node_stdlib_only_no_install_step_runs_in_ci
  - two_invariants_recorded_vs_actual_each_server_pin_eq_doc_pin_intra_repo_consistency_all_servers_pin_same_value
  - ci_spec_version_job_runs_check_plus_its_own_node_test_suite
  - bump_procedure_documented_in_doc_release_notes_then_doc_then_servers_then_lockfiles_then_local_run_then_pr
  - upstream_modelcontextprotocol_io_verification_intentionally_offline_avoid_ci_dns_flakes
  - d_008_canonical_sdk_version_in_markdown_source_of_truth_not_in_one_servers_package_json
  - node_25_strict_parser_balked_at_jsdoc_with_package_word_switched_to_plain_double_slash_comments_node_20_ci_will_work
  - filesystem_sandbox_ci_gap_pre_existing_not_in_scope_for_this_issue
  - cookbook_now_one_priority_med_away_from_v0_1_complete_remaining_issue_4_internal_tools_bridge
decisions_made: [D-008]
followups: []
---

---
session: 2026-05-18T03:55Z
duration_min: 50
issue: 4
focus: internal_tools_bridge_fourth_cookbook_server
delta:
  files_changed: 13
  tests_added: 20
context_for_next_session:
  - fourth_cookbook_server_internal_tools_bridge_ships_d_009
  - bundled_cli_bin_repo_stats_mjs_dep_free_node_stdlib_walks_directory_returns_json
  - bridge_posture_shell_false_allowlist_env_passlist_output_cap_timeout_each_pinned_by_regression_test
  - root_readme_servers_list_3_to_4_decisions_list_gains_d_009
  - ci_workflow_now_has_internal_tools_bridge_job_mirrors_existing_per_server_shape
  - spec_version_drift_check_passes_with_4_servers_at_sdk_1_5_0
decisions_made: [D-009]
followups: []
---

---
session: 2026-05-18T04:35Z
duration_min: 10
issue: 10
focus: ci_add_filesystem_sandbox_job
delta:
  files_changed: 1
  tests_added: 0
context_for_next_session:
  - five_per_server_ci_jobs_now_postgres_github_internal_tools_filesystem
  - no_new_d_entry_pure_ci_gap_fill
  - pr_stacked_on_pr_12_internal_tools_bridge
decisions_made: []
followups: []
---
