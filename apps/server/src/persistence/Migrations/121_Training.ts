import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE training_datasets (
      dataset_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT NOT NULL CHECK (objective IN ('sft', 'dpo')),
      filter_json TEXT NOT NULL,
      redaction_options_json TEXT NOT NULL,
      redaction_audit_json TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      provenance_hash TEXT NOT NULL,
      source_thread_ids_json TEXT NOT NULL,
      train_count INTEGER NOT NULL,
      valid_count INTEGER NOT NULL,
      test_count INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX training_datasets_created_idx
    ON training_datasets(created_at DESC) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE TABLE training_curated_threads (
      bucket_name TEXT NOT NULL DEFAULT 'default',
      thread_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      note TEXT,
      PRIMARY KEY (bucket_name, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX training_curated_threads_thread_idx
    ON training_curated_threads(thread_id)
  `;
  yield* sql`
    CREATE TABLE training_jobs (
      job_id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES training_datasets(dataset_id),
      name TEXT NOT NULL,
      backend TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'draining_inference', 'preparing_dataset',
        'training', 'fusing', 'completed', 'failed', 'cancelled'
      )),
      status_message TEXT,
      error_category TEXT,
      config_json TEXT NOT NULL,
      job_dir TEXT NOT NULL,
      latest_metric_json TEXT,
      truncation_warnings_count INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX training_jobs_status_created_idx
    ON training_jobs(status, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX training_jobs_dataset_idx
    ON training_jobs(dataset_id, created_at DESC)
  `;
  yield* sql`
    CREATE TABLE training_artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES training_jobs(job_id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL REFERENCES training_datasets(dataset_id),
      base_model TEXT NOT NULL,
      fine_tune_type TEXT NOT NULL,
      adapter_path TEXT NOT NULL,
      fused_model_path TEXT,
      gguf_path TEXT,
      provenance_hash TEXT NOT NULL,
      source_thread_ids_json TEXT NOT NULL,
      test_loss REAL,
      test_perplexity REAL,
      registered_inference_server_id TEXT,
      serving_port INTEGER,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX training_artifacts_created_idx
    ON training_artifacts(created_at DESC)
  `;
  yield* sql`
    CREATE TABLE training_eval_runs (
      eval_run_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES training_artifacts(artifact_id) ON DELETE CASCADE,
      suite TEXT NOT NULL CHECK (suite IN ('heldout_perplexity', 'local_coding')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      base_summary_json TEXT,
      tuned_summary_json TEXT,
      report_path TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX training_eval_runs_artifact_idx
    ON training_eval_runs(artifact_id, created_at DESC)
  `;
});
