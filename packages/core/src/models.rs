use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use std::time::SystemTimeError;
use std::io;
use std::fmt;
use std::str::FromStr;
use sqlx::Type;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationError {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EngineError {
    ValidationError(String),
    DatabaseError(String),
    GitError(String),
    WorkspaceError(String),
    ExecutorError(String),
    ConfigError(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::DatabaseError(msg) => write!(f, "Database error: {}", msg),
            EngineError::GitError(msg) => write!(f, "Git error: {}", msg),
            EngineError::WorkspaceError(msg) => write!(f, "Workspace error: {}", msg),
            EngineError::ExecutorError(msg) => write!(f, "Executor error: {}", msg),
            EngineError::ValidationError(err) => write!(f, "Validation error: {}", err),
            EngineError::ConfigError(err) => write!(f, "Config error: {}", err),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<SystemTimeError> for EngineError {
    fn from(err: SystemTimeError) -> Self {
        EngineError::WorkspaceError(format!("System time error: {}", err))
    }
}

impl From<io::Error> for EngineError {
    fn from(err: io::Error) -> Self {
        EngineError::WorkspaceError(format!("IO error: {}", err))
    }
}

impl From<ArtifactError> for EngineError {
    fn from(err: ArtifactError) -> Self {
        EngineError::ValidationError(err.to_string())
    }
}

impl From<sqlx::Error> for EngineError {
    fn from(err: sqlx::Error) -> Self {
        EngineError::DatabaseError(err.to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Type)]
#[sqlx(type_name = "pipeline_status", rename_all = "lowercase")]
pub enum PipelineStatus {
    Unspecified = 0,
    Pending = 1,
    Running = 2,
    Completed = 3,
    Failed = 4,
}

impl From<i32> for PipelineStatus {
    fn from(value: i32) -> Self {
        match value {
            0 => PipelineStatus::Unspecified,
            1 => PipelineStatus::Pending,
            2 => PipelineStatus::Running,
            3 => PipelineStatus::Completed,
            4 => PipelineStatus::Failed,
            _ => PipelineStatus::Unspecified,
        }
    }
}

impl From<PipelineStatus> for i32 {
    fn from(status: PipelineStatus) -> Self {
        status as i32
    }
}

impl std::fmt::Display for PipelineStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PipelineStatus::Unspecified => write!(f, "unspecified"),
            PipelineStatus::Pending => write!(f, "pending"),
            PipelineStatus::Running => write!(f, "running"),
            PipelineStatus::Completed => write!(f, "completed"),
            PipelineStatus::Failed => write!(f, "failed"),
        }
    }
}

impl std::str::FromStr for PipelineStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "unspecified" => Ok(PipelineStatus::Unspecified),
            "pending" => Ok(PipelineStatus::Pending),
            "running" => Ok(PipelineStatus::Running),
            "completed" => Ok(PipelineStatus::Completed),
            "failed" => Ok(PipelineStatus::Failed),
            _ => Err(format!("Invalid pipeline status: {}", s)),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Type)]
#[sqlx(type_name = "build_status", rename_all = "lowercase")]
pub enum BuildStatus {
    Unspecified = 0,
    Pending = 1,
    Running = 2,
    Success = 3,
    Failed = 4,
    Cancelled = 5,
    TimedOut = 6,
}

impl From<i32> for BuildStatus {
    fn from(value: i32) -> Self {
        match value {
            0 => BuildStatus::Unspecified,
            1 => BuildStatus::Pending,
            2 => BuildStatus::Running,
            3 => BuildStatus::Success,
            4 => BuildStatus::Failed,
            5 => BuildStatus::Cancelled,
            6 => BuildStatus::TimedOut,
            _ => BuildStatus::Unspecified,
        }
    }
}

impl From<BuildStatus> for i32 {
    fn from(status: BuildStatus) -> Self {
        status as i32
    }
}

impl std::str::FromStr for BuildStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "unspecified" => Ok(BuildStatus::Unspecified),
            "pending" => Ok(BuildStatus::Pending),
            "running" => Ok(BuildStatus::Running),
            "success" => Ok(BuildStatus::Success),
            "failed" => Ok(BuildStatus::Failed),
            "cancelled" => Ok(BuildStatus::Cancelled),
            "timedout" => Ok(BuildStatus::TimedOut),
            _ => Err(format!("Invalid build status: {}", s)),
        }
    }
}

impl std::fmt::Display for BuildStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BuildStatus::Unspecified => write!(f, "unspecified"),
            BuildStatus::Pending => write!(f, "pending"),
            BuildStatus::Running => write!(f, "running"),
            BuildStatus::Success => write!(f, "success"),
            BuildStatus::Failed => write!(f, "failed"),
            BuildStatus::Cancelled => write!(f, "cancelled"),
            BuildStatus::TimedOut => write!(f, "timedout"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Type)]
#[sqlx(type_name = "step_status", rename_all = "lowercase")]
pub enum StepStatus {
    Unspecified = 0,
    Pending = 1,
    Running = 2,
    Success = 3,
    Failed = 4,
    Cancelled = 5,
    TimedOut = 6,
    Skipped = 7,
}

impl From<i32> for StepStatus {
    fn from(value: i32) -> Self {
        match value {
            0 => StepStatus::Unspecified,
            1 => StepStatus::Pending,
            2 => StepStatus::Running,
            3 => StepStatus::Success,
            4 => StepStatus::Failed,
            5 => StepStatus::Cancelled,
            6 => StepStatus::TimedOut,
            7 => StepStatus::Skipped,
            _ => StepStatus::Unspecified,
        }
    }
}

impl From<StepStatus> for i32 {
    fn from(status: StepStatus) -> Self {
        status as i32
    }
}

impl std::str::FromStr for StepStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "unspecified" => Ok(StepStatus::Unspecified),
            "pending" => Ok(StepStatus::Pending),
            "running" => Ok(StepStatus::Running),
            "success" => Ok(StepStatus::Success),
            "failed" => Ok(StepStatus::Failed),
            "cancelled" => Ok(StepStatus::Cancelled),
            "timedout" => Ok(StepStatus::TimedOut),
            "skipped" => Ok(StepStatus::Skipped),
            _ => Err(format!("Invalid step status: {}", s)),
        }
    }
}

impl std::fmt::Display for StepStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepStatus::Unspecified => write!(f, "unspecified"),
            StepStatus::Pending => write!(f, "pending"),
            StepStatus::Running => write!(f, "running"),
            StepStatus::Success => write!(f, "success"),
            StepStatus::Failed => write!(f, "failed"),
            StepStatus::Cancelled => write!(f, "cancelled"),
            StepStatus::TimedOut => write!(f, "timedout"),
            StepStatus::Skipped => write!(f, "skipped"),
        }
    }
}

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("Storage error: {0}")]
    StorageError(String),
    #[error("Insufficient space for artifact: needed {needed} bytes, available {available} bytes")]
    InsufficientSpace { needed: u64, available: u64 },
    #[error("Artifact not found: {0}")]
    NotFound(String),
    #[error("Invalid artifact: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub name: String,
    pub command: String,
    pub timeout_seconds: u32,
    pub environment: HashMap<String, String>,
    pub dependencies: Vec<String>,
    pub status: StepStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pipeline {
    pub id: String,
    pub name: String,
    pub repository: String,
    pub workspace_id: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub status: PipelineStatus,
    pub steps: Vec<Step>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub step_id: String,
    pub status: StepStatus,
    pub output: String,
    pub error: String,
    pub exit_code: Option<i32>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Build {
    pub id: String,
    pub pipeline_id: String,
    pub branch: String,
    pub commit: String,
    pub status: BuildStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub parameters: HashMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactMetadata {
    pub id: String,
    pub version: String,
    pub build_id: Uuid,
    pub pipeline_id: Uuid,
    pub step_id: String,
    pub created_at: DateTime<Utc>,
    pub size_bytes: u64,
    pub content_hash: String,
    pub retention_policy: RetentionPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub keep_last_n: Option<usize>,
    pub keep_successful: bool,
    pub min_age_days: Option<u32>,
    pub patterns_to_keep: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: Uuid,
    pub build_id: Uuid,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildLog {
    pub step_id: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateBuildRequest {
    pub pipeline_id: String,
    pub branch: String,
    pub commit: String,
    pub parameters: HashMap<String, String>,
}

impl From<serde_json::Error> for EngineError {
    fn from(err: serde_json::Error) -> Self {
        EngineError::ValidationError(err.to_string())
    }
}

// Database Models
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbPipeline {
    pub id: Uuid,
    pub name: String,
    pub repository: String,
    pub workspace_id: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbStep {
    pub id: String,
    pub pipeline_id: Uuid,
    pub build_id: Uuid,
    pub name: String,
    pub command: String,
    pub status: String,
    pub environment: Value,
    pub dependencies: Value,
    pub timeout_seconds: Option<i32>,
    pub retries: Option<i32>,
    pub working_dir: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct DbBuild {
    pub id: Uuid,
    pub pipeline_id: Uuid,
    pub status: String,
    pub branch: String,
    pub commit: String,
    pub parameters: Value,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DbPipelineStatus {
    Unspecified,
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DbBuildStatus {
    Unspecified,
    Pending,
    Running,
    Success,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DbStepStatus {
    Unspecified,
    Pending,
    Running,
    Success,
    Failed,
    Cancelled,
    TimedOut,
    Skipped,
}