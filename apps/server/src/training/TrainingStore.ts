import {
  InferenceServerId,
  RedactionAuditReport,
  RedactionOptions,
  ThreadId,
  TrainerBackendId,
  TrainingArtifact,
  TrainingArtifactId,
  TrainingCuratedThread,
  TrainingDatasetFilter,
  TrainingDatasetId,
  TrainingDatasetSummary,
  TrainingEvalComparison,
  TrainingEvalModelSummary,
  TrainingEvalRunId,
  TrainingEvalStatus,
  TrainingEvalSuite,
  TrainingFineTuneType,
  TrainingJobConfig,
  TrainingJobErrorCategory,
  TrainingJobId,
  TrainingJobSnapshot,
  TrainingJobStatus,
  TrainingMetricTick,
  TrainingObjective,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TrainingStoreError extends Schema.TaggedError<TrainingStoreError>()(
  "TrainingStoreError",
  {
    operation: Schema.String,
    resourceId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.resourceId === undefined
      ? `Training store operation '${this.operation}' failed.`
      : `Training store operation '${this.operation}' failed for '${this.resourceId}'.`;
  }
}

interface CuratedThreadRow {
  readonly bucket_name: string;
  readonly thread_id: string;
  readonly added_at: string;
  readonly note: string | null;
}

interface DatasetRow {
  readonly dataset_id: string;
  readonly name: string;
  readonly objective: TrainingObjective;
  readonly filter_json: string;
  readonly redaction_options_json: string;
  readonly redaction_audit_json: string;
  readonly storage_path: string;
  readonly provenance_hash: string;
  readonly source_thread_ids_json: string;
  readonly train_count: number | bigint;
  readonly valid_count: number | bigint;
  readonly test_count: number | bigint;
  readonly estimated_tokens: number | bigint;
  readonly size_bytes: number | bigint;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

interface JobRow {
  readonly job_id: string;
  readonly dataset_id: string;
  readonly name: string;
  readonly backend: TrainerBackendId;
  readonly status: TrainingJobStatus;
  readonly status_message: string | null;
  readonly error_category: TrainingJobErrorCategory | null;
  readonly config_json: string;
  readonly job_dir: string;
  readonly latest_metric_json: string | null;
  readonly truncation_warnings_count: number | bigint;
  readonly pid: number | bigint | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface ArtifactRow {
  readonly artifact_id: string;
  readonly job_id: string;
  readonly dataset_id: string;
  readonly base_model: string;
  readonly fine_tune_type: TrainingFineTuneType;
  readonly adapter_path: string;
  readonly fused_model_path: string | null;
  readonly gguf_path: string | null;
  readonly provenance_hash: string;
  readonly source_thread_ids_json: string;
  readonly test_loss: number | null;
  readonly test_perplexity: number | null;
  readonly registered_inference_server_id: string | null;
  readonly serving_port: number | bigint | null;
  readonly created_at: string;
}

interface EvalRunRow {
  readonly eval_run_id: string;
  readonly artifact_id: string;
  readonly suite: TrainingEvalSuite;
  readonly status: TrainingEvalStatus;
  readonly base_summary_json: string | null;
  readonly tuned_summary_json: string | null;
  readonly report_path: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

const encodeJson = (value: unknown): string => JSON.stringify(value);

const decodeDatasetFilterJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(TrainingDatasetFilter),
);
const decodeRedactionOptionsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(RedactionOptions),
);
const decodeRedactionAuditJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(RedactionAuditReport),
);
const decodeThreadIdsJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ThreadId)));
const decodeJobConfigJson = Schema.decodeUnknownSync(Schema.fromJsonString(TrainingJobConfig));
const decodeMetricTickJson = Schema.decodeUnknownSync(Schema.fromJsonString(TrainingMetricTick));
const decodeEvalModelSummaryJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(TrainingEvalModelSummary),
);

const decodeDatasetRow = (row: DatasetRow): TrainingDatasetSummary => ({
  id: TrainingDatasetId.make(row.dataset_id),
  name: row.name,
  objective: row.objective,
  filter: decodeDatasetFilterJson(row.filter_json),
  redactionOptions: decodeRedactionOptionsJson(row.redaction_options_json),
  redactionAudit: decodeRedactionAuditJson(row.redaction_audit_json),
  storagePath: row.storage_path,
  provenanceHash: row.provenance_hash,
  sourceThreadIds: decodeThreadIdsJson(row.source_thread_ids_json),
  trainCount: Number(row.train_count),
  validCount: Number(row.valid_count),
  testCount: Number(row.test_count),
  estimatedTokens: Number(row.estimated_tokens),
  sizeBytes: Number(row.size_bytes),
  createdAt: row.created_at,
});

const decodeArtifactRow = (row: ArtifactRow): TrainingArtifact => ({
  id: TrainingArtifactId.make(row.artifact_id),
  jobId: TrainingJobId.make(row.job_id),
  datasetId: TrainingDatasetId.make(row.dataset_id),
  baseModel: row.base_model,
  fineTuneType: row.fine_tune_type,
  adapterPath: row.adapter_path,
  fusedModelPath: row.fused_model_path,
  ggufPath: row.gguf_path,
  provenanceHash: row.provenance_hash,
  sourceThreadIds: decodeThreadIdsJson(row.source_thread_ids_json),
  ...(row.test_loss === null ? {} : { testLoss: row.test_loss }),
  ...(row.test_perplexity === null ? {} : { testPerplexity: row.test_perplexity }),
  registeredInferenceServerId:
    row.registered_inference_server_id === null
      ? null
      : InferenceServerId.make(row.registered_inference_server_id),
  servingPort: row.serving_port === null ? null : Number(row.serving_port),
  createdAt: row.created_at,
});

const decodeJobRow = (row: JobRow, artifact: TrainingArtifact | null): TrainingJobSnapshot => {
  const latestMetric =
    row.latest_metric_json === null ? null : decodeMetricTickJson(row.latest_metric_json);
  return {
    id: TrainingJobId.make(row.job_id),
    config: decodeJobConfigJson(row.config_json),
    status: row.status,
    ...(row.status_message === null ? {} : { statusMessage: row.status_message }),
    ...(row.error_category === null ? {} : { errorCategory: row.error_category }),
    latestMetric,
    recentMetrics: latestMetric === null ? [] : [latestMetric],
    truncationWarningsCount: Number(row.truncation_warnings_count),
    artifact,
    jobDir: row.job_dir,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
};

const decodeEvalRunRow = (row: EvalRunRow): TrainingEvalComparison => ({
  id: TrainingEvalRunId.make(row.eval_run_id),
  artifactId: TrainingArtifactId.make(row.artifact_id),
  suite: row.suite,
  status: row.status,
  baseSummary:
    row.base_summary_json === null ? null : decodeEvalModelSummaryJson(row.base_summary_json),
  tunedSummary:
    row.tuned_summary_json === null ? null : decodeEvalModelSummaryJson(row.tuned_summary_json),
  reportPath: row.report_path,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

export interface TrainingJobUpdatePatch {
  readonly status?: TrainingJobStatus;
  readonly statusMessage?: string | null;
  readonly errorCategory?: TrainingJobErrorCategory | null;
  readonly latestMetric?: TrainingMetricTick | null;
  readonly truncationWarningsCount?: number;
  readonly pid?: number | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface TrainingArtifactUpdatePatch {
  readonly fusedModelPath?: string | null;
  readonly ggufPath?: string | null;
  readonly testLoss?: number | null;
  readonly testPerplexity?: number | null;
  readonly registeredInferenceServerId?: InferenceServerId | null;
  readonly servingPort?: number | null;
}

export interface TrainingEvalRunUpdatePatch {
  readonly status?: TrainingEvalStatus;
  readonly baseSummary?: TrainingEvalModelSummary | null;
  readonly tunedSummary?: TrainingEvalModelSummary | null;
  readonly reportPath?: string | null;
  readonly completedAt?: string | null;
}

export class TrainingStore extends Context.Service<
  TrainingStore,
  {
    readonly listCuratedThreads: (
      bucketName?: string,
    ) => Effect.Effect<ReadonlyArray<TrainingCuratedThread>, TrainingStoreError>;
    readonly setCuratedThread: (input: {
      readonly threadId: ThreadId;
      readonly curated: boolean;
      readonly bucketName?: string | undefined;
      readonly note?: string | null | undefined;
    }) => Effect.Effect<
      { readonly bucketName: string; readonly curated: boolean },
      TrainingStoreError
    >;

    readonly insertDataset: (
      dataset: TrainingDatasetSummary,
    ) => Effect.Effect<void, TrainingStoreError>;
    readonly listDatasets: Effect.Effect<ReadonlyArray<TrainingDatasetSummary>, TrainingStoreError>;
    readonly getDataset: (
      datasetId: TrainingDatasetId,
    ) => Effect.Effect<TrainingDatasetSummary | null, TrainingStoreError>;
    readonly softDeleteDataset: (
      datasetId: TrainingDatasetId,
    ) => Effect.Effect<boolean, TrainingStoreError>;

    readonly insertJob: (
      job: TrainingJobSnapshot,
      pid?: number | null,
    ) => Effect.Effect<void, TrainingStoreError>;
    readonly updateJob: (
      jobId: TrainingJobId,
      patch: TrainingJobUpdatePatch,
    ) => Effect.Effect<TrainingJobSnapshot | null, TrainingStoreError>;
    readonly getJob: (
      jobId: TrainingJobId,
    ) => Effect.Effect<TrainingJobSnapshot | null, TrainingStoreError>;
    readonly listJobs: Effect.Effect<ReadonlyArray<TrainingJobSnapshot>, TrainingStoreError>;

    readonly upsertArtifact: (
      artifact: TrainingArtifact,
    ) => Effect.Effect<void, TrainingStoreError>;
    readonly updateArtifact: (
      artifactId: TrainingArtifactId,
      patch: TrainingArtifactUpdatePatch,
    ) => Effect.Effect<TrainingArtifact | null, TrainingStoreError>;
    readonly getArtifact: (
      artifactId: TrainingArtifactId,
    ) => Effect.Effect<TrainingArtifact | null, TrainingStoreError>;
    readonly getArtifactByJobId: (
      jobId: TrainingJobId,
    ) => Effect.Effect<TrainingArtifact | null, TrainingStoreError>;
    readonly listArtifacts: Effect.Effect<ReadonlyArray<TrainingArtifact>, TrainingStoreError>;

    readonly insertEvalRun: (
      evalRun: TrainingEvalComparison,
    ) => Effect.Effect<void, TrainingStoreError>;
    readonly updateEvalRun: (
      evalRunId: TrainingEvalRunId,
      patch: TrainingEvalRunUpdatePatch,
    ) => Effect.Effect<TrainingEvalComparison | null, TrainingStoreError>;
    readonly getEvalRun: (
      evalRunId: TrainingEvalRunId,
    ) => Effect.Effect<TrainingEvalComparison | null, TrainingStoreError>;
    readonly listEvalRuns: (
      artifactId?: TrainingArtifactId,
    ) => Effect.Effect<ReadonlyArray<TrainingEvalComparison>, TrainingStoreError>;

    readonly reconcileStaleJobsOnStartup: Effect.Effect<
      { readonly reconciledJobCount: number; readonly clearedServingPorts: number },
      TrainingStoreError
    >;
  }
>()("t3/training/TrainingStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const mapSqlError =
    (operation: string, resourceId?: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TrainingStoreError, R> =>
      Effect.mapError(
        effect,
        (cause) =>
          new TrainingStoreError({
            operation,
            ...(resourceId === undefined ? {} : { resourceId }),
            cause,
          }),
      );

  const getArtifactByJobId = Effect.fn("TrainingStore.getArtifactByJobId")(function* (
    jobId: TrainingJobId,
  ) {
    const rows = yield* sql<ArtifactRow>`
      SELECT artifact_id, job_id, dataset_id, base_model, fine_tune_type, adapter_path,
             fused_model_path, gguf_path, provenance_hash, source_thread_ids_json,
             test_loss, test_perplexity, registered_inference_server_id, serving_port, created_at
      FROM training_artifacts
      WHERE job_id = ${jobId}
    `.pipe(mapSqlError("getArtifactByJobId", jobId));
    const row = rows[0];
    return row === undefined ? null : decodeArtifactRow(row);
  });

  const getJob = Effect.fn("TrainingStore.getJob")(function* (jobId: TrainingJobId) {
    const rows = yield* sql<JobRow>`
      SELECT job_id, dataset_id, name, backend, status, status_message, error_category,
             config_json, job_dir, latest_metric_json, truncation_warnings_count, pid,
             created_at, started_at, completed_at
      FROM training_jobs
      WHERE job_id = ${jobId}
    `.pipe(mapSqlError("getJob", jobId));
    const row = rows[0];
    if (row === undefined) return null;
    const artifact = yield* getArtifactByJobId(jobId);
    return decodeJobRow(row, artifact);
  });

  const getArtifact = Effect.fn("TrainingStore.getArtifact")(function* (
    artifactId: TrainingArtifactId,
  ) {
    const rows = yield* sql<ArtifactRow>`
      SELECT artifact_id, job_id, dataset_id, base_model, fine_tune_type, adapter_path,
             fused_model_path, gguf_path, provenance_hash, source_thread_ids_json,
             test_loss, test_perplexity, registered_inference_server_id, serving_port, created_at
      FROM training_artifacts
      WHERE artifact_id = ${artifactId}
    `.pipe(mapSqlError("getArtifact", artifactId));
    const row = rows[0];
    return row === undefined ? null : decodeArtifactRow(row);
  });

  const getEvalRun = Effect.fn("TrainingStore.getEvalRun")(function* (
    evalRunId: TrainingEvalRunId,
  ) {
    const rows = yield* sql<EvalRunRow>`
      SELECT eval_run_id, artifact_id, suite, status, base_summary_json, tuned_summary_json,
             report_path, created_at, completed_at
      FROM training_eval_runs
      WHERE eval_run_id = ${evalRunId}
    `.pipe(mapSqlError("getEvalRun", evalRunId));
    const row = rows[0];
    return row === undefined ? null : decodeEvalRunRow(row);
  });

  return TrainingStore.of({
    listCuratedThreads: Effect.fn("TrainingStore.listCuratedThreads")(function* (
      bucketName = "default",
    ) {
      const rows = yield* sql<CuratedThreadRow>`
        SELECT bucket_name, thread_id, added_at, note
        FROM training_curated_threads
        WHERE bucket_name = ${bucketName}
        ORDER BY added_at DESC, thread_id ASC
      `.pipe(mapSqlError("listCuratedThreads", bucketName));
      return rows.map((row) => ({
        bucketName: row.bucket_name,
        threadId: ThreadId.make(row.thread_id),
        addedAt: row.added_at,
        note: row.note,
      }));
    }),

    setCuratedThread: Effect.fn("TrainingStore.setCuratedThread")(function* (input) {
      const bucketName = input.bucketName ?? "default";
      if (input.curated) {
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO training_curated_threads (bucket_name, thread_id, added_at, note)
          VALUES (${bucketName}, ${input.threadId}, ${at}, ${input.note ?? null})
          ON CONFLICT (bucket_name, thread_id) DO UPDATE
          SET note = COALESCE(excluded.note, training_curated_threads.note)
        `.pipe(mapSqlError("setCuratedThread", input.threadId));
      } else {
        yield* sql`
          DELETE FROM training_curated_threads
          WHERE bucket_name = ${bucketName} AND thread_id = ${input.threadId}
        `.pipe(mapSqlError("setCuratedThread", input.threadId));
      }
      return { bucketName, curated: input.curated };
    }),

    insertDataset: Effect.fn("TrainingStore.insertDataset")(function* (dataset) {
      yield* sql`
        INSERT INTO training_datasets (
          dataset_id, name, objective, filter_json, redaction_options_json, redaction_audit_json,
          storage_path, provenance_hash, source_thread_ids_json, train_count, valid_count,
          test_count, estimated_tokens, size_bytes, created_at, deleted_at
        ) VALUES (
          ${dataset.id}, ${dataset.name}, ${dataset.objective},
          ${encodeJson(dataset.filter)}, ${encodeJson(dataset.redactionOptions)},
          ${encodeJson(dataset.redactionAudit)}, ${dataset.storagePath},
          ${dataset.provenanceHash}, ${encodeJson(dataset.sourceThreadIds)},
          ${dataset.trainCount}, ${dataset.validCount}, ${dataset.testCount},
          ${dataset.estimatedTokens}, ${dataset.sizeBytes}, ${dataset.createdAt}, NULL
        )
      `.pipe(mapSqlError("insertDataset", dataset.id));
    }),

    listDatasets: Effect.gen(function* () {
      const rows = yield* sql<DatasetRow>`
        SELECT dataset_id, name, objective, filter_json, redaction_options_json,
               redaction_audit_json, storage_path, provenance_hash, source_thread_ids_json,
               train_count, valid_count, test_count, estimated_tokens, size_bytes,
               created_at, deleted_at
        FROM training_datasets
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC, dataset_id DESC
      `.pipe(mapSqlError("listDatasets"));
      return rows.map(decodeDatasetRow);
    }).pipe(Effect.withSpan("TrainingStore.listDatasets")),

    getDataset: Effect.fn("TrainingStore.getDataset")(function* (datasetId) {
      const rows = yield* sql<DatasetRow>`
        SELECT dataset_id, name, objective, filter_json, redaction_options_json,
               redaction_audit_json, storage_path, provenance_hash, source_thread_ids_json,
               train_count, valid_count, test_count, estimated_tokens, size_bytes,
               created_at, deleted_at
        FROM training_datasets
        WHERE dataset_id = ${datasetId} AND deleted_at IS NULL
      `.pipe(mapSqlError("getDataset", datasetId));
      const row = rows[0];
      return row === undefined ? null : decodeDatasetRow(row);
    }),

    softDeleteDataset: Effect.fn("TrainingStore.softDeleteDataset")(function* (datasetId) {
      const at = yield* nowIso;
      const rows = yield* sql<{ readonly dataset_id: string }>`
        UPDATE training_datasets
        SET deleted_at = ${at}
        WHERE dataset_id = ${datasetId} AND deleted_at IS NULL
        RETURNING dataset_id
      `.pipe(mapSqlError("softDeleteDataset", datasetId));
      return rows.length > 0;
    }),

    insertJob: Effect.fn("TrainingStore.insertJob")(function* (job, pid = null) {
      yield* sql`
        INSERT INTO training_jobs (
          job_id, dataset_id, name, backend, status, status_message, error_category,
          config_json, job_dir, latest_metric_json, truncation_warnings_count, pid,
          created_at, started_at, completed_at
        ) VALUES (
          ${job.id}, ${job.config.datasetId}, ${job.config.name}, ${job.config.backend},
          ${job.status}, ${job.statusMessage ?? null}, ${job.errorCategory ?? null},
          ${encodeJson(job.config)}, ${job.jobDir},
          ${job.latestMetric === null ? null : encodeJson(job.latestMetric)},
          ${job.truncationWarningsCount}, ${pid}, ${job.createdAt},
          ${job.startedAt}, ${job.completedAt}
        )
      `.pipe(mapSqlError("insertJob", job.id));
    }),

    updateJob: Effect.fn("TrainingStore.updateJob")(function* (jobId, patch) {
      const existing = yield* sql<JobRow>`
        SELECT job_id, dataset_id, name, backend, status, status_message, error_category,
               config_json, job_dir, latest_metric_json, truncation_warnings_count, pid,
               created_at, started_at, completed_at
        FROM training_jobs
        WHERE job_id = ${jobId}
      `.pipe(mapSqlError("updateJob", jobId));
      const current = existing[0];
      if (current === undefined) return null;

      const status = patch.status ?? current.status;
      const statusMessage =
        patch.statusMessage === undefined ? current.status_message : patch.statusMessage;
      const errorCategory =
        patch.errorCategory === undefined ? current.error_category : patch.errorCategory;
      const latestMetricJson =
        patch.latestMetric === undefined
          ? current.latest_metric_json
          : patch.latestMetric === null
            ? null
            : encodeJson(patch.latestMetric);
      const truncationWarningsCount =
        patch.truncationWarningsCount ?? Number(current.truncation_warnings_count);
      const pid =
        patch.pid === undefined ? (current.pid === null ? null : Number(current.pid)) : patch.pid;
      const startedAt = patch.startedAt === undefined ? current.started_at : patch.startedAt;
      const completedAt =
        patch.completedAt === undefined ? current.completed_at : patch.completedAt;

      yield* sql`
        UPDATE training_jobs
        SET status = ${status},
            status_message = ${statusMessage},
            error_category = ${errorCategory},
            latest_metric_json = ${latestMetricJson},
            truncation_warnings_count = ${truncationWarningsCount},
            pid = ${pid},
            started_at = ${startedAt},
            completed_at = ${completedAt}
        WHERE job_id = ${jobId}
      `.pipe(mapSqlError("updateJob", jobId));

      return yield* getJob(jobId);
    }),

    getJob,

    listJobs: Effect.gen(function* () {
      const [jobRows, artifactRows] = yield* Effect.all([
        sql<JobRow>`
          SELECT job_id, dataset_id, name, backend, status, status_message, error_category,
                 config_json, job_dir, latest_metric_json, truncation_warnings_count, pid,
                 created_at, started_at, completed_at
          FROM training_jobs
          ORDER BY created_at DESC, job_id DESC
        `.pipe(mapSqlError("listJobs")),
        sql<ArtifactRow>`
          SELECT artifact_id, job_id, dataset_id, base_model, fine_tune_type, adapter_path,
                 fused_model_path, gguf_path, provenance_hash, source_thread_ids_json,
                 test_loss, test_perplexity, registered_inference_server_id, serving_port, created_at
          FROM training_artifacts
        `.pipe(mapSqlError("listJobs")),
      ]);
      const artifactByJob = new Map<string, TrainingArtifact>();
      for (const row of artifactRows) {
        artifactByJob.set(row.job_id, decodeArtifactRow(row));
      }
      return jobRows.map((row) => decodeJobRow(row, artifactByJob.get(row.job_id) ?? null));
    }).pipe(Effect.withSpan("TrainingStore.listJobs")),

    upsertArtifact: Effect.fn("TrainingStore.upsertArtifact")(function* (artifact) {
      yield* sql`
        INSERT INTO training_artifacts (
          artifact_id, job_id, dataset_id, base_model, fine_tune_type, adapter_path,
          fused_model_path, gguf_path, provenance_hash, source_thread_ids_json,
          test_loss, test_perplexity, registered_inference_server_id, serving_port, created_at
        ) VALUES (
          ${artifact.id}, ${artifact.jobId}, ${artifact.datasetId}, ${artifact.baseModel},
          ${artifact.fineTuneType}, ${artifact.adapterPath}, ${artifact.fusedModelPath},
          ${artifact.ggufPath}, ${artifact.provenanceHash},
          ${encodeJson(artifact.sourceThreadIds)}, ${artifact.testLoss ?? null},
          ${artifact.testPerplexity ?? null}, ${artifact.registeredInferenceServerId},
          ${artifact.servingPort}, ${artifact.createdAt}
        )
        ON CONFLICT (artifact_id) DO UPDATE
        SET fused_model_path = excluded.fused_model_path,
            gguf_path = excluded.gguf_path,
            test_loss = excluded.test_loss,
            test_perplexity = excluded.test_perplexity,
            registered_inference_server_id = excluded.registered_inference_server_id,
            serving_port = excluded.serving_port
      `.pipe(mapSqlError("upsertArtifact", artifact.id));
    }),

    updateArtifact: Effect.fn("TrainingStore.updateArtifact")(function* (artifactId, patch) {
      const current = yield* getArtifact(artifactId);
      if (current === null) return null;
      const fusedModelPath =
        patch.fusedModelPath === undefined ? current.fusedModelPath : patch.fusedModelPath;
      const ggufPath = patch.ggufPath === undefined ? current.ggufPath : patch.ggufPath;
      const testLoss = patch.testLoss === undefined ? (current.testLoss ?? null) : patch.testLoss;
      const testPerplexity =
        patch.testPerplexity === undefined
          ? (current.testPerplexity ?? null)
          : patch.testPerplexity;
      const registeredInferenceServerId =
        patch.registeredInferenceServerId === undefined
          ? current.registeredInferenceServerId
          : patch.registeredInferenceServerId;
      const servingPort = patch.servingPort === undefined ? current.servingPort : patch.servingPort;

      yield* sql`
        UPDATE training_artifacts
        SET fused_model_path = ${fusedModelPath},
            gguf_path = ${ggufPath},
            test_loss = ${testLoss},
            test_perplexity = ${testPerplexity},
            registered_inference_server_id = ${registeredInferenceServerId},
            serving_port = ${servingPort}
        WHERE artifact_id = ${artifactId}
      `.pipe(mapSqlError("updateArtifact", artifactId));
      return yield* getArtifact(artifactId);
    }),

    getArtifact,
    getArtifactByJobId,

    listArtifacts: Effect.gen(function* () {
      const rows = yield* sql<ArtifactRow>`
        SELECT artifact_id, job_id, dataset_id, base_model, fine_tune_type, adapter_path,
               fused_model_path, gguf_path, provenance_hash, source_thread_ids_json,
               test_loss, test_perplexity, registered_inference_server_id, serving_port, created_at
        FROM training_artifacts
        ORDER BY created_at DESC, artifact_id DESC
      `.pipe(mapSqlError("listArtifacts"));
      return rows.map(decodeArtifactRow);
    }).pipe(Effect.withSpan("TrainingStore.listArtifacts")),

    insertEvalRun: Effect.fn("TrainingStore.insertEvalRun")(function* (evalRun) {
      yield* sql`
        INSERT INTO training_eval_runs (
          eval_run_id, artifact_id, suite, status, base_summary_json, tuned_summary_json,
          report_path, created_at, completed_at
        ) VALUES (
          ${evalRun.id}, ${evalRun.artifactId}, ${evalRun.suite}, ${evalRun.status},
          ${evalRun.baseSummary === null ? null : encodeJson(evalRun.baseSummary)},
          ${evalRun.tunedSummary === null ? null : encodeJson(evalRun.tunedSummary)},
          ${evalRun.reportPath}, ${evalRun.createdAt}, ${evalRun.completedAt}
        )
      `.pipe(mapSqlError("insertEvalRun", evalRun.id));
    }),

    updateEvalRun: Effect.fn("TrainingStore.updateEvalRun")(function* (evalRunId, patch) {
      const current = yield* getEvalRun(evalRunId);
      if (current === null) return null;

      const status = patch.status ?? current.status;
      const baseSummaryJson =
        patch.baseSummary === undefined
          ? current.baseSummary === null
            ? null
            : encodeJson(current.baseSummary)
          : patch.baseSummary === null
            ? null
            : encodeJson(patch.baseSummary);
      const tunedSummaryJson =
        patch.tunedSummary === undefined
          ? current.tunedSummary === null
            ? null
            : encodeJson(current.tunedSummary)
          : patch.tunedSummary === null
            ? null
            : encodeJson(patch.tunedSummary);
      const reportPath = patch.reportPath === undefined ? current.reportPath : patch.reportPath;
      const completedAt = patch.completedAt === undefined ? current.completedAt : patch.completedAt;

      yield* sql`
        UPDATE training_eval_runs
        SET status = ${status},
            base_summary_json = ${baseSummaryJson},
            tuned_summary_json = ${tunedSummaryJson},
            report_path = ${reportPath},
            completed_at = ${completedAt}
        WHERE eval_run_id = ${evalRunId}
      `.pipe(mapSqlError("updateEvalRun", evalRunId));
      return yield* getEvalRun(evalRunId);
    }),

    getEvalRun,

    listEvalRuns: Effect.fn("TrainingStore.listEvalRuns")(function* (artifactId) {
      const rows =
        artifactId === undefined
          ? yield* sql<EvalRunRow>`
              SELECT eval_run_id, artifact_id, suite, status, base_summary_json,
                     tuned_summary_json, report_path, created_at, completed_at
              FROM training_eval_runs
              ORDER BY created_at DESC, eval_run_id DESC
            `.pipe(mapSqlError("listEvalRuns"))
          : yield* sql<EvalRunRow>`
              SELECT eval_run_id, artifact_id, suite, status, base_summary_json,
                     tuned_summary_json, report_path, created_at, completed_at
              FROM training_eval_runs
              WHERE artifact_id = ${artifactId}
              ORDER BY created_at DESC, eval_run_id DESC
            `.pipe(mapSqlError("listEvalRuns", artifactId));
      return rows.map(decodeEvalRunRow);
    }),

    reconcileStaleJobsOnStartup: Effect.gen(function* () {
      const at = yield* nowIso;
      const staleJobs = yield* sql<{ readonly job_id: string }>`
        UPDATE training_jobs
        SET status = 'failed',
            status_message = 'Server restarted while training job was active.',
            error_category = 'server_restarted',
            pid = NULL,
            completed_at = ${at}
        WHERE status IN ('queued', 'draining_inference', 'preparing_dataset', 'training', 'fusing')
        RETURNING job_id
      `.pipe(mapSqlError("reconcileStaleJobsOnStartup"));

      const clearedPorts = yield* sql<{ readonly artifact_id: string }>`
        UPDATE training_artifacts
        SET serving_port = NULL
        WHERE serving_port IS NOT NULL
        RETURNING artifact_id
      `.pipe(mapSqlError("reconcileStaleJobsOnStartup"));

      yield* sql`
        UPDATE training_eval_runs
        SET status = 'failed', completed_at = ${at}
        WHERE status = 'running'
      `.pipe(mapSqlError("reconcileStaleJobsOnStartup"));

      return {
        reconciledJobCount: staleJobs.length,
        clearedServingPorts: clearedPorts.length,
      };
    }).pipe(Effect.withSpan("TrainingStore.reconcileStaleJobsOnStartup")),
  });
});

export const layer = Layer.effect(TrainingStore, make);
