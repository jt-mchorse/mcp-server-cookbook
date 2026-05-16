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
