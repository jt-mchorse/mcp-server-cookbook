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
