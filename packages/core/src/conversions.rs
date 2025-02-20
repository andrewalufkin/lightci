use crate::models::{Pipeline, Step, Build, PipelineStatus, BuildStatus, StepStatus, StepResult, Artifact, BuildLog};
use crate::models::{DbPipeline, DbStep, DbBuild};
use crate::grpc::proto;
use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;
use std::collections::HashMap;
use std::str::FromStr;
use crate::grpc::proto::StepResult as ProtoStepResult;

impl From<Pipeline> for proto::Pipeline {
    fn from(pipeline: Pipeline) -> Self {
        proto::Pipeline {
            id: pipeline.id,
            name: pipeline.name,
            repository: pipeline.repository,
            workspace_id: pipeline.workspace_id,
            description: pipeline.description.unwrap_or_default(),
            default_branch: pipeline.default_branch,
            status: i32::from(pipeline.status),
            steps: pipeline.steps.into_iter().map(|s| s.into()).collect(),
            created_at: pipeline.created_at.to_rfc3339(),
            updated_at: pipeline.updated_at.to_rfc3339(),
        }
    }
}

impl From<Step> for proto::Step {
    fn from(step: Step) -> Self {
        proto::Step {
            id: step.id.clone(),
            name: step.name.clone(),
            command: step.command.clone(),
            timeout_seconds: step.timeout_seconds,
            environment: step.environment.clone(),
            dependencies: step.dependencies.clone(),
        }
    }
}

impl From<Build> for proto::Build {
    fn from(build: Build) -> Self {
        proto::Build {
            id: build.id.clone(),
            pipeline_id: build.pipeline_id.clone(),
            branch: build.branch.clone(),
            commit: build.commit.clone(),
            status: i32::from(build.status),
            started_at: build.started_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
            completed_at: build.completed_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
            parameters: build.parameters.clone(),
        }
    }
}

pub trait CreatePipelineRequestConversion {
    fn try_into_pipeline(self) -> Result<Pipeline, String>;
}

impl CreatePipelineRequestConversion for proto::CreatePipelineRequest {
    fn try_into_pipeline(self) -> Result<Pipeline, String> {
        Ok(Pipeline {
            id: Uuid::new_v4().to_string(),
            name: self.name,
            repository: self.repository,
            workspace_id: self.workspace_id,
            description: Some(self.description),
            default_branch: self.default_branch,
            status: PipelineStatus::Pending,
            steps: self.steps.into_iter()
                .map(|s| Step {
                    id: Uuid::new_v4().to_string(),
                    name: s.name,
                    command: s.command,
                    timeout_seconds: s.timeout_seconds,
                    environment: s.environment,
                    dependencies: s.dependencies,
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                })
                .collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        })
    }
}

impl TryFrom<proto::CreateBuildRequest> for Build {
    type Error = String;

    fn try_from(req: proto::CreateBuildRequest) -> Result<Self, Self::Error> {
        Ok(Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: req.pipeline_id,
            branch: req.branch,
            commit: req.commit,
            status: BuildStatus::Pending,
            started_at: None,
            completed_at: None,
            parameters: req.parameters,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        })
    }
}

impl From<StepResult> for ProtoStepResult {
    fn from(result: StepResult) -> Self {
        ProtoStepResult {
            step_id: result.step_id,
            status: result.status as i32,
            output: result.output,
            error: result.error,
            started_at: result.started_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            completed_at: result.completed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            exit_code: result.exit_code.unwrap_or(-1),
        }
    }
}

impl From<Artifact> for proto::Artifact {
    fn from(artifact: Artifact) -> Self {
        proto::Artifact {
            id: artifact.id.to_string(),
            build_id: artifact.build_id.to_string(),
            name: artifact.name,
            path: artifact.path,
            size: artifact.size,
            content_type: artifact.content_type.unwrap_or_default(),
            metadata: artifact.metadata,
        }
    }
}

impl From<BuildLog> for proto::BuildLog {
    fn from(log: BuildLog) -> Self {
        proto::BuildLog {
            step_id: log.step_id,
            content: log.content,
            timestamp: log.timestamp.to_rfc3339(),
        }
    }
}

// Add reverse conversions if needed
impl TryFrom<proto::StepResult> for StepResult {
    type Error = String;

    fn try_from(proto: proto::StepResult) -> Result<Self, Self::Error> {
        Ok(StepResult {
            step_id: proto.step_id,
            status: StepStatus::from(proto.status),
            output: proto.output,
            error: proto.error,
            exit_code: Some(proto.exit_code),
            started_at: chrono::DateTime::parse_from_rfc3339(&proto.started_at)
                .ok()
                .map(|dt| dt.with_timezone(&Utc)),
            completed_at: chrono::DateTime::parse_from_rfc3339(&proto.completed_at)
                .ok()
                .map(|dt| dt.with_timezone(&Utc)),
        })
    }
}

impl TryFrom<proto::Artifact> for Artifact {
    type Error = String;

    fn try_from(proto: proto::Artifact) -> Result<Self, Self::Error> {
        Ok(Artifact {
            id: Uuid::parse_str(&proto.id).map_err(|e| e.to_string())?,
            build_id: Uuid::parse_str(&proto.build_id).map_err(|e| e.to_string())?,
            name: proto.name,
            path: proto.path,
            size: proto.size,
            content_type: Some(proto.content_type),
            metadata: proto.metadata,
            created_at: Utc::now(),
        })
    }
}

impl TryFrom<proto::BuildLog> for BuildLog {
    type Error = String;

    fn try_from(proto: proto::BuildLog) -> Result<Self, Self::Error> {
        Ok(BuildLog {
            step_id: proto.step_id,
            content: proto.content,
            timestamp: chrono::DateTime::parse_from_rfc3339(&proto.timestamp)
                .map_err(|e| e.to_string())?
                .with_timezone(&Utc),
        })
    }
} 