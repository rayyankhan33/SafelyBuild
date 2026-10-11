# Entity-relationship diagram (generated)

Generated from the live PostgreSQL schema by `npm run docs:erd`. Do not edit by hand: the test `schema.test.js` fails if this file drifts from the migrations.

```mermaid
erDiagram
  alerts {
    uuid id PK
    uuid project_id FK
    alert_kind kind
    alert_level level
    text dedupe_key
    text technical_msg
    text plain_msg
    timestamp_with_time_zone created_at
    timestamp_with_time_zone resolved_at
    uuid acknowledged_by FK
    timestamp_with_time_zone acknowledged_at
  }
  audit_log {
    bigint id PK
    uuid project_id FK
    uuid user_id FK
    text action
    text entity
    text entity_id
    jsonb details
    timestamp_with_time_zone created_at
  }
  cost_estimates {
    uuid id PK
    uuid project_id FK
    integer version
    numeric total_pkr
    numeric contingency_pct
    jsonb factors_snapshot
    jsonb warnings
    boolean is_active
    uuid created_by FK
    timestamp_with_time_zone created_at
  }
  daily_logs {
    uuid id PK
    uuid project_id FK
    date log_date
    uuid author_id FK
    integer workers_present
    text weather
    text notes
    timestamp_with_time_zone created_at
  }
  defects {
    uuid id PK
    uuid inference_run_id FK
    uuid media_id FK
    uuid project_id FK
    text defect_type
    numeric score
    severity_level severity
    boolean is_violation
    numeric confidence
    int4_array bbox
    date detected_on
  }
  design_elements {
    uuid id PK
    uuid project_id FK
    text label
    element_type element_type
    integer quantity
    numeric length_m
    numeric width_m
    numeric height_m
    numeric thickness_m
    integer concrete_fc_mpa
    numeric rebar_kg_per_m3
    timestamp_with_time_zone created_at
  }
  estimate_lines {
    uuid id PK
    uuid estimate_id FK
    uuid element_id FK
    integer material_id FK
    numeric quantity
    text unit
    numeric rate_pkr
    numeric cost_pkr
  }
  estimation_factors {
    text key PK
    numeric value
    text unit
    text description
    integer standard_id FK
    boolean is_code_value
  }
  forecasts {
    uuid id PK
    uuid project_id FK
    date as_of
    jsonb budget
    jsonb schedule
  }
  hazard_library {
    integer id PK
    text code
    text category
    text title
    text description
    jsonb causes
    jsonb consequences
    jsonb preventive_controls
    jsonb mitigating_controls
    integer default_likelihood
    integer default_severity
    integer standard_id FK
  }
  hazards {
    uuid id PK
    uuid project_id FK
    integer library_id FK
    uuid defect_id FK
    hazard_source source
    text category
    text title
    text notes
    integer likelihood
    integer severity
    integer risk_rating
    hazard_status status
    date identified_on
    uuid created_by FK
    timestamp_with_time_zone created_at
  }
  inference_runs {
    uuid id PK
    uuid media_id FK
    inference_kind kind
    text backend
    inference_status status
    jsonb result
    text error
    timestamp_with_time_zone started_at
    timestamp_with_time_zone finished_at
  }
  material_catalog {
    integer id PK
    text code
    text name
    text unit
  }
  material_usage {
    uuid id PK
    uuid daily_log_id FK
    integer material_id FK
    numeric quantity
    numeric rate_pkr
    numeric cost_pkr
    entry_source source
    numeric confidence
    uuid media_id FK
    timestamp_with_time_zone created_at
  }
  media {
    uuid id PK
    uuid project_id FK
    uuid daily_log_id FK
    media_kind kind
    text tag
    text storage_key
    text sha256
    text content_type
    integer size_bytes
    numeric latitude
    numeric longitude
    timestamp_with_time_zone captured_at
    uuid uploaded_by FK
    timestamp_with_time_zone created_at
  }
  organizations {
    uuid id PK
    text name
    timestamp_with_time_zone created_at
  }
  productivity_rates {
    element_type element_type PK
    text unit
    numeric output_per_day
    integer min_duration_days
    integer sequence_no
  }
  project_material_rates {
    uuid project_id PK
    integer material_id PK
    numeric rate_pkr
    timestamp_with_time_zone updated_at
  }
  project_members {
    uuid project_id PK
    uuid user_id PK
  }
  projects {
    uuid id PK
    uuid org_id FK
    text name
    text location
    text description
    project_status status
    date start_date
    date planned_end_date
    numeric budget_pkr
    uuid created_by FK
    timestamp_with_time_zone created_at
  }
  risk_scores {
    uuid id PK
    uuid project_id FK
    date score_date
    numeric sdi
    numeric severity_part
    numeric density_part
    numeric progression_part
    jsonb weights
    traffic_light status
    text explanation
  }
  schedule_tasks {
    uuid id PK
    uuid project_id FK
    uuid element_id FK
    text name
    integer seq
    date planned_start
    date planned_end
    numeric planned_cost_pkr
  }
  standards_refs {
    integer id PK
    text code
    text title
    text body
    text used_for
  }
  task_dependencies {
    uuid task_id PK
    uuid depends_on_id PK
  }
  task_progress {
    uuid id PK
    uuid daily_log_id FK
    uuid task_id FK
    numeric percent_complete
  }
  users {
    uuid id PK
    uuid org_id FK
    text email
    text password_hash
    text full_name
    user_role role
    text pec_number
    boolean is_active
    timestamp_with_time_zone created_at
  }
  projects ||--o{ alerts : "project_id"
  users |o--o{ alerts : "acknowledged_by"
  projects |o--o{ audit_log : "project_id"
  users |o--o{ audit_log : "user_id"
  projects ||--o{ cost_estimates : "project_id"
  users |o--o{ cost_estimates : "created_by"
  projects ||--o{ daily_logs : "project_id"
  users ||--o{ daily_logs : "author_id"
  inference_runs ||--o{ defects : "inference_run_id"
  media ||--o{ defects : "media_id"
  projects ||--o{ defects : "project_id"
  projects ||--o{ design_elements : "project_id"
  cost_estimates ||--o{ estimate_lines : "estimate_id"
  design_elements |o--o{ estimate_lines : "element_id"
  material_catalog ||--o{ estimate_lines : "material_id"
  standards_refs |o--o{ estimation_factors : "standard_id"
  projects ||--o{ forecasts : "project_id"
  standards_refs |o--o{ hazard_library : "standard_id"
  defects |o--o{ hazards : "defect_id"
  hazard_library |o--o{ hazards : "library_id"
  projects ||--o{ hazards : "project_id"
  users |o--o{ hazards : "created_by"
  media ||--o{ inference_runs : "media_id"
  daily_logs ||--o{ material_usage : "daily_log_id"
  material_catalog ||--o{ material_usage : "material_id"
  media |o--o{ material_usage : "media_id"
  daily_logs |o--o{ media : "daily_log_id"
  projects ||--o{ media : "project_id"
  users ||--o{ media : "uploaded_by"
  material_catalog ||--o{ project_material_rates : "material_id"
  projects ||--o{ project_material_rates : "project_id"
  projects ||--o{ project_members : "project_id"
  users ||--o{ project_members : "user_id"
  organizations ||--o{ projects : "org_id"
  users |o--o{ projects : "created_by"
  projects ||--o{ risk_scores : "project_id"
  design_elements |o--o{ schedule_tasks : "element_id"
  projects ||--o{ schedule_tasks : "project_id"
  schedule_tasks ||--o{ task_dependencies : "depends_on_id"
  schedule_tasks ||--o{ task_dependencies : "task_id"
  daily_logs ||--o{ task_progress : "daily_log_id"
  schedule_tasks ||--o{ task_progress : "task_id"
  organizations ||--o{ users : "org_id"
```
