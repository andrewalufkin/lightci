use sqlx::{Pool, Postgres, postgres::PgPoolOptions, Type};
use crate::models::{Pipeline, Build, Artifact, PipelineStatus, BuildStatus, StepStatus, Step, EngineError};
use uuid::Uuid;
use std::collections::HashMap;
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use std::str::FromStr;
use tokio::sync::Mutex;
use crate::models::{DbPipeline, DbBuild, DbStep, DbPipelineStatus, DbBuildStatus, DbStepStatus};
use crate::models::BuildLog;

impl From<PipelineStatus> for DbPipelineStatus {
    fn from(status: PipelineStatus) -> Self {
        match status {
            PipelineStatus::Unspecified => DbPipelineStatus::Unspecified,
            PipelineStatus::Pending => DbPipelineStatus::Pending,
            PipelineStatus::Running => DbPipelineStatus::Running,
            PipelineStatus::Completed => DbPipelineStatus::Completed,
            PipelineStatus::Failed => DbPipelineStatus::Failed,
        }
    }
}

impl From<DbPipelineStatus> for PipelineStatus {
    fn from(status: DbPipelineStatus) -> Self {
        match status {
            DbPipelineStatus::Unspecified => PipelineStatus::Unspecified,
            DbPipelineStatus::Pending => PipelineStatus::Pending,
            DbPipelineStatus::Running => PipelineStatus::Running,
            DbPipelineStatus::Completed => PipelineStatus::Completed,
            DbPipelineStatus::Failed => PipelineStatus::Failed,
        }
    }
}

impl From<BuildStatus> for DbBuildStatus {
    fn from(status: BuildStatus) -> Self {
        match status {
            BuildStatus::Unspecified => DbBuildStatus::Unspecified,
            BuildStatus::Pending => DbBuildStatus::Pending,
            BuildStatus::Running => DbBuildStatus::Running,
            BuildStatus::Success => DbBuildStatus::Success,
            BuildStatus::Failed => DbBuildStatus::Failed,
            BuildStatus::Cancelled => DbBuildStatus::Cancelled,
            BuildStatus::TimedOut => DbBuildStatus::TimedOut,
        }
    }
}

impl From<DbBuildStatus> for BuildStatus {
    fn from(status: DbBuildStatus) -> Self {
        match status {
            DbBuildStatus::Unspecified => BuildStatus::Unspecified,
            DbBuildStatus::Pending => BuildStatus::Pending,
            DbBuildStatus::Running => BuildStatus::Running,
            DbBuildStatus::Success => BuildStatus::Success,
            DbBuildStatus::Failed => BuildStatus::Failed,
            DbBuildStatus::Cancelled => BuildStatus::Cancelled,
            DbBuildStatus::TimedOut => BuildStatus::TimedOut,
        }
    }
}

impl From<StepStatus> for DbStepStatus {
    fn from(status: StepStatus) -> Self {
        match status {
            StepStatus::Unspecified => DbStepStatus::Unspecified,
            StepStatus::Pending => DbStepStatus::Pending,
            StepStatus::Running => DbStepStatus::Running,
            StepStatus::Success => DbStepStatus::Success,
            StepStatus::Failed => DbStepStatus::Failed,
            StepStatus::Cancelled => DbStepStatus::Cancelled,
            StepStatus::TimedOut => DbStepStatus::TimedOut,
            StepStatus::Skipped => DbStepStatus::Skipped,
        }
    }
}

impl From<DbStepStatus> for StepStatus {
    fn from(status: DbStepStatus) -> Self {
        match status {
            DbStepStatus::Unspecified => StepStatus::Unspecified,
            DbStepStatus::Pending => StepStatus::Pending,
            DbStepStatus::Running => StepStatus::Running,
            DbStepStatus::Success => StepStatus::Success,
            DbStepStatus::Failed => StepStatus::Failed,
            DbStepStatus::Cancelled => StepStatus::Cancelled,
            DbStepStatus::TimedOut => StepStatus::TimedOut,
            DbStepStatus::Skipped => StepStatus::Skipped,
        }
    }
}

impl From<String> for PipelineStatus {
    fn from(s: String) -> Self {
        match s.as_str() {
            "unspecified" => PipelineStatus::Unspecified,
            "pending" => PipelineStatus::Pending,
            "running" => PipelineStatus::Running,
            "completed" => PipelineStatus::Completed,
            "failed" => PipelineStatus::Failed,
            _ => PipelineStatus::Unspecified,
        }
    }
}

impl From<PipelineStatus> for String {
    fn from(status: PipelineStatus) -> Self {
        match status {
            PipelineStatus::Unspecified => "unspecified".to_string(),
            PipelineStatus::Pending => "pending".to_string(),
            PipelineStatus::Running => "running".to_string(),
            PipelineStatus::Completed => "completed".to_string(),
            PipelineStatus::Failed => "failed".to_string(),
        }
    }
}

impl From<String> for BuildStatus {
    fn from(s: String) -> Self {
        match s.as_str() {
            "unspecified" => BuildStatus::Unspecified,
            "pending" => BuildStatus::Pending,
            "running" => BuildStatus::Running,
            "success" => BuildStatus::Success,
            "failed" => BuildStatus::Failed,
            "cancelled" => BuildStatus::Cancelled,
            "timedout" => BuildStatus::TimedOut,
            _ => BuildStatus::Unspecified,
        }
    }
}

impl From<BuildStatus> for String {
    fn from(status: BuildStatus) -> Self {
        match status {
            BuildStatus::Unspecified => "unspecified".to_string(),
            BuildStatus::Pending => "pending".to_string(),
            BuildStatus::Running => "running".to_string(),
            BuildStatus::Success => "success".to_string(),
            BuildStatus::Failed => "failed".to_string(),
            BuildStatus::Cancelled => "cancelled".to_string(),
            BuildStatus::TimedOut => "timedout".to_string(),
        }
    }
}

impl From<String> for StepStatus {
    fn from(s: String) -> Self {
        match s.as_str() {
            "unspecified" => StepStatus::Unspecified,
            "pending" => StepStatus::Pending,
            "running" => StepStatus::Running,
            "success" => StepStatus::Success,
            "failed" => StepStatus::Failed,
            "cancelled" => StepStatus::Cancelled,
            "timedout" => StepStatus::TimedOut,
            "skipped" => StepStatus::Skipped,
            _ => StepStatus::Unspecified,
        }
    }
}

impl From<StepStatus> for String {
    fn from(status: StepStatus) -> Self {
        match status {
            StepStatus::Unspecified => "unspecified".to_string(),
            StepStatus::Pending => "pending".to_string(),
            StepStatus::Running => "running".to_string(),
            StepStatus::Success => "success".to_string(),
            StepStatus::Failed => "failed".to_string(),
            StepStatus::Cancelled => "cancelled".to_string(),
            StepStatus::TimedOut => "timedout".to_string(),
            StepStatus::Skipped => "skipped".to_string(),
        }
    }
}

#[derive(Clone)]
pub struct Database {
    pool: Pool<Postgres>,
}

impl Database {
    pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn create_pipeline(&self, pipeline: Pipeline) -> Result<Pipeline, sqlx::Error> {
        let db_pipeline = DbPipeline::from(pipeline);

        let record = sqlx::query_as!(
            DbPipeline,
            r#"
            INSERT INTO pipelines (id, name, repository, workspace_id, description, default_branch, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
            "#,
            db_pipeline.id,
            db_pipeline.name,
            db_pipeline.repository,
            db_pipeline.workspace_id,
            db_pipeline.description,
            db_pipeline.default_branch,
            db_pipeline.status,
            db_pipeline.created_at,
            db_pipeline.updated_at
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(Pipeline::from(record))
    }

    pub async fn get_pipeline(&self, id: &str) -> Result<Pipeline, sqlx::Error> {
        let pipeline_id = Uuid::parse_str(id).map_err(|_| sqlx::Error::RowNotFound)?;

        let record = sqlx::query_as!(
            DbPipeline,
            r#"
            SELECT * FROM pipelines WHERE id = $1
            "#,
            pipeline_id
        )
        .fetch_one(&self.pool)
        .await?;

        let steps = sqlx::query_as!(
            DbStep,
            r#"
            SELECT 
                ps.id as "id!: String",
                ps.pipeline_id as "pipeline_id!: Uuid",
                NULL as "build_id?: Uuid",
                ps.name as "name!: String",
                ps.command as "command!: String",
                'pending' as "status!: String",
                ps.environment as "environment!: JsonValue",
                COALESCE(jsonb_build_array(ps.dependencies), '[]'::jsonb) as "dependencies!: JsonValue",
                ps.timeout_seconds as "timeout_seconds?: i32",
                0 as "retries?: i32",
                NULL as "working_dir?: String",
                ps.created_at as "created_at!: DateTime<Utc>",
                ps.created_at as "updated_at!: DateTime<Utc>"
            FROM pipeline_steps ps
            WHERE ps.pipeline_id = $1
            "#,
            pipeline_id
        )
        .fetch_all(&self.pool)
        .await?;

        let mut pipeline = Pipeline::from(record);
        pipeline.steps = steps.into_iter().map(Step::from).collect();
        Ok(pipeline)
    }

    pub async fn delete_pipeline(&self, id: &str) -> Result<(), sqlx::Error> {
        let pipeline_id = Uuid::parse_str(id).map_err(|_| sqlx::Error::RowNotFound)?;

        sqlx::query!(
            r#"
            DELETE FROM pipelines WHERE id = $1
            "#,
            pipeline_id
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn list_pipelines(&self, limit: i64, offset: i64) -> Result<Vec<Pipeline>, sqlx::Error> {
        let records = sqlx::query_as!(
            DbPipeline,
            r#"
            SELECT * FROM pipelines 
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
            "#,
            limit,
            offset
        )
        .fetch_all(&self.pool)
        .await?;

        let mut results = Vec::new();
        for record in records {
            let steps = sqlx::query_as!(
                DbStep,
                r#"
                SELECT 
                    ps.id as "id!: String",
                    ps.pipeline_id as "pipeline_id!: Uuid",
                    NULL as "build_id?: Uuid",
                    ps.name as "name!: String",
                    ps.command as "command!: String",
                    'pending' as "status!: String",
                    ps.environment as "environment!: JsonValue",
                    COALESCE(jsonb_build_array(ps.dependencies), '[]'::jsonb) as "dependencies!: JsonValue",
                    ps.timeout_seconds as "timeout_seconds?: i32",
                    0 as "retries?: i32",
                    NULL as "working_dir?: String",
                    ps.created_at as "created_at!: DateTime<Utc>",
                    ps.created_at as "updated_at!: DateTime<Utc>"
                FROM pipeline_steps ps
                WHERE ps.pipeline_id = $1
                "#,
                record.id
            )
            .fetch_all(&self.pool)
            .await?;

            let mut pipeline = Pipeline::from(record);
            pipeline.steps = steps.into_iter().map(Step::from).collect();
            results.push(pipeline);
        }

        Ok(results)
    }

    pub async fn create_build(&self, build: Build) -> Result<Build, sqlx::Error> {
        let db_build = DbBuild::from(build);

        let record = sqlx::query_as!(
            DbBuild,
            r#"
            INSERT INTO builds (id, pipeline_id, status, branch, commit, parameters, started_at, completed_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
            "#,
            db_build.id,
            db_build.pipeline_id,
            db_build.status,
            db_build.branch,
            db_build.commit,
            db_build.parameters,
            db_build.started_at,
            db_build.completed_at,
            db_build.created_at,
            db_build.updated_at
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(Build::from(record))
    }

    pub async fn get_build(&self, id: &str) -> Result<Build, sqlx::Error> {
        let build_id = Uuid::parse_str(id).map_err(|_| sqlx::Error::RowNotFound)?;

        let record = sqlx::query_as!(
            DbBuild,
            r#"
            SELECT * FROM builds WHERE id = $1
            "#,
            build_id
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(Build::from(record))
    }

    pub async fn list_builds(&self, limit: i64, offset: i64) -> Result<Vec<Build>, sqlx::Error> {
        let records = sqlx::query_as!(
            DbBuild,
            r#"
            SELECT * FROM builds 
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
            "#,
            limit,
            offset
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(records.into_iter().map(Build::from).collect())
    }

    pub async fn update_build_status(&self, id: &str, status: BuildStatus) -> Result<Build, sqlx::Error> {
        let build_id = Uuid::parse_str(id).map_err(|_| sqlx::Error::RowNotFound)?;

        let record = sqlx::query_as!(
            DbBuild,
            r#"
            UPDATE builds 
            SET status = $2, 
                updated_at = $3
            WHERE id = $1
            RETURNING *
            "#,
            build_id,
            String::from(status),
            Utc::now()
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(Build::from(record))
    }

    pub async fn update_step_status(&self, id: &str, status: StepStatus) -> Result<Step, sqlx::Error> {
        let step_id = id.to_string();
        let status_str = String::from(status);

        let record = sqlx::query_as!(
            DbStep,
            r#"
            WITH updated AS (
                UPDATE steps 
                SET status = $1, updated_at = $2
                WHERE id = $3
                RETURNING *
            )
            SELECT 
                u.id as "id!: String",
                b.pipeline_id as "pipeline_id!: Uuid",
                u.build_id as "build_id?: Uuid",
                u.name as "name!: String",
                u.command as "command!: String",
                u.status as "status!: String",
                u.environment as "environment!: JsonValue",
                u.dependencies as "dependencies!: JsonValue",
                u.timeout_seconds as "timeout_seconds?: i32",
                u.retries as "retries?: i32",
                u.working_dir as "working_dir?: String",
                u.created_at as "created_at!: DateTime<Utc>",
                u.updated_at as "updated_at!: DateTime<Utc>"
            FROM updated u
            INNER JOIN builds b ON u.build_id = b.id
            "#,
            status_str,
            Utc::now(),
            step_id
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(Step::from(record))
    }

    pub async fn get_pipeline_steps(&self, pipeline_id: Uuid) -> Result<Vec<Step>, sqlx::Error> {
        let steps = sqlx::query_as!(
            DbStep,
            r#"
            SELECT 
                ps.id as "id!: String",
                ps.pipeline_id as "pipeline_id!: Uuid",
                NULL as "build_id?: Uuid",
                ps.name as "name!: String",
                ps.command as "command!: String",
                'pending' as "status!: String",
                ps.environment as "environment!: JsonValue",
                COALESCE(jsonb_build_array(ps.dependencies), '[]'::jsonb) as "dependencies!: JsonValue",
                ps.timeout_seconds as "timeout_seconds?: i32",
                0 as "retries?: i32",
                NULL as "working_dir?: String",
                ps.created_at as "created_at!: DateTime<Utc>",
                ps.created_at as "updated_at!: DateTime<Utc>"
            FROM pipeline_steps ps
            WHERE ps.pipeline_id = $1
            "#,
            pipeline_id
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(steps.into_iter().map(Step::from).collect())
    }

    pub async fn get_build_logs(&self, build_id: &str) -> Result<Vec<BuildLog>, sqlx::Error> {
        let build_uuid = Uuid::parse_str(build_id).map_err(|_| sqlx::Error::RowNotFound)?;
        
        sqlx::query_as!(
            BuildLog,
            r#"
            SELECT step_id, content, timestamp
            FROM build_logs
            WHERE build_id = $1
            ORDER BY timestamp ASC
            "#,
            build_uuid
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn get_build_steps(&self, build_id: &str) -> Result<Vec<Step>, sqlx::Error> {
        let build_uuid = Uuid::parse_str(build_id).map_err(|_| sqlx::Error::RowNotFound)?;

        let steps = sqlx::query_as!(
            DbStep,
            r#"
            SELECT 
                s.id as "id!: String",
                b.pipeline_id as "pipeline_id!: Uuid",
                s.build_id as "build_id?: Uuid",
                s.name as "name!: String",
                s.command as "command!: String",
                s.status as "status!: String",
                s.environment as "environment!: JsonValue",
                s.dependencies as "dependencies!: JsonValue",
                s.timeout_seconds as "timeout_seconds?: i32",
                s.retries as "retries?: i32",
                s.working_dir as "working_dir?: String",
                s.created_at as "created_at!: DateTime<Utc>",
                s.updated_at as "updated_at!: DateTime<Utc>"
            FROM steps s
            INNER JOIN builds b ON s.build_id = b.id
            WHERE s.build_id = $1
            "#,
            build_uuid
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(steps.into_iter().map(Step::from).collect())
    }

    pub async fn update_pipeline(&self, pipeline: &Pipeline) -> Result<Pipeline, sqlx::Error> {
        let db_pipeline = DbPipeline::from(pipeline.clone());
        sqlx::query!(
            r#"
            UPDATE pipelines
            SET name = $1, repository = $2, workspace_id = $3, description = $4, default_branch = $5, status = $6, updated_at = $7
            WHERE id = $8
            RETURNING *
            "#,
            db_pipeline.name,
            db_pipeline.repository,
            db_pipeline.workspace_id,
            db_pipeline.description,
            db_pipeline.default_branch,
            db_pipeline.status,
            Utc::now(),
            Uuid::from_str(&pipeline.id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        )
        .fetch_one(&self.pool)
        .await
        .map(|record| {
            let mut pipeline = Pipeline::from(DbPipeline {
                id: record.id,
                name: record.name,
                repository: record.repository,
                workspace_id: record.workspace_id,
                description: record.description,
                default_branch: record.default_branch,
                status: record.status.to_string(),
                created_at: record.created_at,
                updated_at: record.updated_at,
            });
            pipeline.steps = Vec::new();
            pipeline
        })
    }

    pub async fn update_build(&self, build: &Build) -> Result<Build, sqlx::Error> {
        let db_build = DbBuild::from(build.clone());
        sqlx::query!(
            r#"
            UPDATE builds
            SET pipeline_id = $1, status = $2, branch = $3, commit = $4, parameters = $5, started_at = $6, completed_at = $7, updated_at = $8
            WHERE id = $9
            RETURNING *
            "#,
            Uuid::from_str(&build.pipeline_id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?,
            db_build.status,
            db_build.branch,
            db_build.commit,
            db_build.parameters,
            db_build.started_at,
            db_build.completed_at,
            Utc::now(),
            Uuid::from_str(&build.id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        )
        .fetch_one(&self.pool)
        .await
        .map(|record| Build::from(DbBuild {
            id: record.id,
            pipeline_id: record.pipeline_id,
            status: record.status,
            branch: record.branch,
            commit: record.commit,
            parameters: record.parameters,
            started_at: record.started_at,
            completed_at: record.completed_at,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }))
    }
}

impl From<DbPipeline> for Pipeline {
    fn from(record: DbPipeline) -> Self {
        Pipeline {
            id: record.id.to_string(),
            name: record.name,
            repository: record.repository,
            workspace_id: record.workspace_id,
            description: record.description,
            default_branch: record.default_branch,
            status: PipelineStatus::from(record.status),
            steps: Vec::new(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

impl From<DbBuild> for Build {
    fn from(record: DbBuild) -> Self {
        Build {
            id: record.id.to_string(),
            pipeline_id: record.pipeline_id.to_string(),
            branch: record.branch,
            commit: record.commit,
            status: BuildStatus::from_str(&record.status).unwrap_or(BuildStatus::Unspecified),
            started_at: record.started_at,
            completed_at: record.completed_at,
            parameters: serde_json::from_value(record.parameters).unwrap_or_default(),
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

impl From<DbStep> for Step {
    fn from(db_step: DbStep) -> Self {
        Step {
            id: db_step.id,
            name: db_step.name,
            command: db_step.command,
            timeout_seconds: db_step.timeout_seconds.unwrap_or(3600) as u32, // Default to 1 hour
            environment: serde_json::from_value(db_step.environment).unwrap_or_default(),
            dependencies: serde_json::from_value(db_step.dependencies).unwrap_or_default(),
            status: StepStatus::from(db_step.status),
            created_at: db_step.created_at,
            updated_at: db_step.updated_at,
        }
    }
}

impl From<Pipeline> for DbPipeline {
    fn from(pipeline: Pipeline) -> Self {
        DbPipeline {
            id: Uuid::parse_str(&pipeline.id).unwrap_or_else(|_| Uuid::new_v4()),
            name: pipeline.name,
            repository: pipeline.repository,
            workspace_id: pipeline.workspace_id,
            description: pipeline.description,
            default_branch: pipeline.default_branch,
            status: pipeline.status.to_string(),
            created_at: pipeline.created_at,
            updated_at: pipeline.updated_at,
        }
    }
}

impl From<Build> for DbBuild {
    fn from(build: Build) -> Self {
        DbBuild {
            id: Uuid::parse_str(&build.id).unwrap_or_else(|_| Uuid::new_v4()),
            pipeline_id: Uuid::parse_str(&build.pipeline_id).unwrap_or_else(|_| Uuid::new_v4()),
            branch: build.branch,
            commit: build.commit,
            status: String::from(build.status),
            started_at: build.started_at,
            completed_at: build.completed_at,
            parameters: serde_json::to_value(build.parameters).unwrap_or(JsonValue::Null),
            created_at: build.created_at,
            updated_at: build.updated_at,
        }
    }
}

impl From<Step> for DbStep {
    fn from(step: Step) -> Self {
        DbStep {
            id: step.id.clone(),
            pipeline_id: Uuid::new_v4(), // This should be set by the caller
            build_id: None, // This should be set by the caller when needed
            name: step.name.clone(),
            command: step.command.clone(),
            status: step.status.to_string(),
            environment: serde_json::to_value(step.environment).unwrap_or(JsonValue::Null),
            dependencies: serde_json::to_value(step.dependencies).unwrap_or(JsonValue::Null),
            timeout_seconds: Some(step.timeout_seconds as i32),
            retries: Some(0), // Default value
            working_dir: None,
            created_at: step.created_at,
            updated_at: step.updated_at,
        }
    }
} 