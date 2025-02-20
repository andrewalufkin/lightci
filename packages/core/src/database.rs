use sqlx::{Pool, Postgres};
use crate::proto::{Pipeline, Step, Build, Artifact, StepStatus};
use chrono::Utc;
use std::collections::HashMap;
use thiserror::Error;
use uuid::Uuid;
use serde_json;

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("Database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("Record not found")]
    NotFound,
}

pub struct Database {
    pool: Pool<Postgres>,
}

impl Database {
    pub async fn new(database_url: &str) -> Result<Self, DatabaseError> {
        let pool = Pool::connect(database_url).await?;
        Ok(Self { pool })
    }

    pub async fn create_pipeline(&mut self, pipeline: Pipeline) -> Result<Pipeline, DatabaseError> {
        let mut tx = self.pool.begin().await?;

        // Insert pipeline
        sqlx::query!(
            r#"
            INSERT INTO pipelines (
                id, name, repository, workspace_id, description, default_branch, status,
                created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
            pipeline.id,
            pipeline.name,
            pipeline.repository,
            pipeline.workspace_id,
            pipeline.description,
            pipeline.default_branch,
            pipeline.status,
            pipeline.created_at,
            pipeline.updated_at,
        )
        .execute(&mut tx)
        .await?;

        // Insert steps
        for step in &pipeline.steps {
            sqlx::query!(
                r#"
                INSERT INTO pipeline_steps (
                    id, pipeline_id, name, command, status, environment,
                    dependencies, timeout_seconds, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                "#,
                step.id,
                pipeline.id,
                step.name,
                step.command,
                step.status.to_string(),
                &step.environment,
                &step.dependencies,
                step.timeout_seconds as i32,
                step.created_at,
                step.updated_at,
            )
            .execute(&mut tx)
            .await?;
        }

        tx.commit().await?;
        Ok(pipeline)
    }

    pub async fn get_pipeline(&self, id: &str) -> Result<Pipeline, DatabaseError> {
        let pipeline = sqlx::query!(
            r#"
            SELECT id, name, repository, workspace_id, description, default_branch,
                   status, created_at, updated_at
            FROM pipelines
            WHERE id = $1
            "#,
            id
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::RowNotFound => DatabaseError::NotFound,
            e => DatabaseError::Sqlx(e)
        })?;

        let steps = sqlx::query!(
            r#"
            SELECT 
                id, pipeline_id, name, command, status,
                environment, dependencies, timeout_seconds,
                created_at, updated_at
            FROM pipeline_steps
            WHERE pipeline_id = $1
            ORDER BY created_at ASC
            "#,
            id
        )
        .fetch_all(&self.pool)
        .await?;

        let steps = steps
            .into_iter()
            .map(|row| Step {
                id: row.id,
                name: row.name,
                command: row.command,
                status: row.status.parse().unwrap_or(StepStatus::Pending),
                environment: row.environment.unwrap_or_default(),
                dependencies: row.dependencies.unwrap_or_default(),
                timeout_seconds: row.timeout_seconds.unwrap_or(0) as u32,
                created_at: row.created_at,
                updated_at: row.updated_at,
            })
            .collect();

        Ok(Pipeline {
            id: pipeline.id,
            name: pipeline.name,
            repository: pipeline.repository,
            workspace_id: pipeline.workspace_id,
            description: pipeline.description,
            default_branch: pipeline.default_branch,
            status: pipeline.status,
            steps,
            created_at: pipeline.created_at,
            updated_at: pipeline.updated_at,
        })
    }

    pub async fn update_step_status(&self, build_id: Uuid, step_name: &str, status: StepStatus) -> Result<(), Error> {
        sqlx::query!(
            r#"
            UPDATE pipeline_steps
            SET status = $1
            WHERE build_id = $2 AND name = $3
            "#,
            status.to_string(),
            build_id,
            step_name
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn get_step_status(
        &self,
        pipeline_id: &str,
        step_name: &str,
    ) -> Result<StepStatus, DatabaseError> {
        let status = sqlx::query!(
            r#"
            SELECT status
            FROM pipeline_steps
            WHERE pipeline_id = $1 AND name = $2
            "#,
            pipeline_id,
            step_name,
        )
        .fetch_one(&self.pool)
        .await?
        .status;

        Ok(status.into())
    }

    pub async fn update_pipeline(&self, pipeline: &Pipeline) -> Result<Pipeline, DatabaseError> {
        let mut tx = self.pool.begin().await?;

        // Update pipeline
        sqlx::query!(
            r#"
            UPDATE pipelines
            SET name = $1, repository = $2, workspace_id = $3, description = $4, default_branch = $5, status = $6, updated_at = $7
            WHERE id = $8
            RETURNING *
            "#,
            pipeline.name,
            pipeline.repository,
            pipeline.workspace_id,
            pipeline.description,
            pipeline.default_branch,
            pipeline.status,
            Utc::now(),
            Uuid::parse_str(&pipeline.id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        )
        .fetch_one(&mut tx)
        .await?;

        // Delete existing steps
        sqlx::query!(
            r#"
            DELETE FROM pipeline_steps WHERE pipeline_id = $1
            "#,
            Uuid::parse_str(&pipeline.id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?
        )
        .execute(&mut tx)
        .await?;

        // Insert new steps
        for step in &pipeline.steps {
            sqlx::query!(
                r#"
                INSERT INTO pipeline_steps (
                    id, pipeline_id, name, command, environment,
                    dependencies, timeout_seconds
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                "#,
                step.id,
                Uuid::parse_str(&pipeline.id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?,
                step.name,
                step.command,
                serde_json::to_value(&step.environment).unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
                &step.dependencies,
                step.timeout_seconds as i32,
            )
            .execute(&mut tx)
            .await?;
        }

        tx.commit().await?;
        Ok(pipeline.clone())
    }
} 