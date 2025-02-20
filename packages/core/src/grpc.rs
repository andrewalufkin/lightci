use tonic::{transport::Server, Request, Response, Status, Streaming};
use std::sync::Arc;
use crate::engine::PipelineEngine;
use crate::models::{Pipeline as CorePipeline, Build as CoreBuild, Step as CoreStep};
use crate::models::{PipelineStatus as CorePipelineStatus, BuildStatus as CoreBuildStatus, StepStatus as CoreStepStatus};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use std::pin::Pin;
use futures::Stream;
use std::collections::HashMap;
use std::str::FromStr;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/lightci.rs"));
}

use proto::engine_service_server::EngineServiceServer;
use proto::{
    Pipeline as ProtoPipeline,
    Build as ProtoBuild,
    Step as ProtoStep,
    PipelineStatus as ProtoPipelineStatus,
    BuildStatus as ProtoBuildStatus,
    StepStatus as ProtoStepStatus,
    CreatePipelineRequest, GetPipelineRequest, UpdatePipelineRequest, DeletePipelineRequest,
    ListPipelinesRequest, ListPipelinesResponse, TriggerBuildRequest, GetBuildRequest,
    CancelBuildRequest, ListBuildsRequest, ListBuildsResponse, GetBuildLogsRequest,
    BuildLogs, Empty, UploadArtifactRequest, DownloadArtifactRequest, DownloadArtifactResponse,
    ListArtifactsRequest, ListArtifactsResponse, SubscribeToStepUpdatesRequest, StepStatusUpdateResponse,
    Artifact,
};

use crate::proto::engine_service_server::EngineService;

pub struct GrpcServer {
    engine: Arc<PipelineEngine>,
}

impl GrpcServer {
    pub fn new(engine: Arc<PipelineEngine>) -> Self {
        Self { engine }
    }

    pub async fn serve(self, addr: &str) -> Result<(), Box<dyn std::error::Error>> {
        let addr = addr.parse()?;
        println!("gRPC server listening on {}", addr);

        Server::builder()
            .add_service(EngineServiceServer::new(self))
            .serve(addr)
            .await?;

        Ok(())
    }

    fn pipeline_to_proto(&self, pipeline: &CorePipeline) -> proto::Pipeline {
        proto::Pipeline {
            id: pipeline.id.clone(),
            name: pipeline.name.clone(),
            repository: pipeline.repository.clone(),
            workspace_id: pipeline.workspace_id.clone(),
            description: pipeline.description.clone().unwrap_or_default(),
            default_branch: pipeline.default_branch.clone(),
            status: i32::from(pipeline.status),
            steps: pipeline.steps.iter().map(|s| self.step_to_proto(s)).collect(),
            created_at: pipeline.created_at.to_rfc3339(),
            updated_at: pipeline.updated_at.to_rfc3339(),
        }
    }

    fn build_to_proto(&self, build: &CoreBuild) -> ProtoBuild {
        ProtoBuild {
            id: build.id.clone(),
            pipeline_id: build.pipeline_id.clone(),
            branch: build.branch.clone(),
            commit: build.commit.clone(),
            status: build.status.into(),
            started_at: build.started_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            completed_at: build.completed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            parameters: build.parameters.clone(),
        }
    }

    fn step_to_proto(&self, step: &CoreStep) -> ProtoStep {
        ProtoStep {
            id: step.id.clone(),
            name: step.name.clone(),
            command: step.command.clone(),
            timeout_seconds: step.timeout_seconds,
            environment: step.environment.clone(),
            dependencies: step.dependencies.clone(),
        }
    }
}

#[tonic::async_trait]
impl proto::engine_service_server::EngineService for GrpcServer {
    type DownloadArtifactStream = Pin<Box<dyn Stream<Item = Result<proto::DownloadArtifactResponse, Status>> + Send + 'static>>;
    type SubscribeToStepUpdatesStream = Pin<Box<dyn Stream<Item = Result<proto::StepStatusUpdateResponse, Status>> + Send + 'static>>;

    async fn create_pipeline(
        &self,
        request: Request<proto::CreatePipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        let pipeline = CorePipeline {
            id: Uuid::new_v4().to_string(),
            name: req.name,
            repository: req.repository,
            workspace_id: req.workspace_id,
            description: Some(req.description),
            default_branch: req.default_branch,
            status: CorePipelineStatus::Pending,
            steps: req.steps.into_iter()
                .map(|s| CoreStep {
                    id: Uuid::new_v4().to_string(),
                    name: s.name,
                    command: s.command,
                    timeout_seconds: s.timeout_seconds,
                    environment: s.environment,
                    dependencies: s.dependencies,
                    status: CoreStepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                })
                .collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let created = self.engine
            .create_pipeline(pipeline)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(self.pipeline_to_proto(&created)))
    }

    async fn get_pipeline(
        &self,
        request: Request<GetPipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        let pipeline = self.engine
            .get_pipeline(&req.id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(self.pipeline_to_proto(&pipeline)))
    }

    async fn update_pipeline(
        &self,
        request: Request<UpdatePipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        let pipeline = CorePipeline {
            id: req.id.clone(),
            name: req.name.clone(),
            repository: req.repository.clone(),
            workspace_id: req.id.clone(),
            description: Some(req.description.clone()),
            default_branch: req.default_branch.clone(),
            status: CorePipelineStatus::Pending,
            steps: req.steps.iter().map(|s| CoreStep {
                id: s.id.clone(),
                name: s.name.clone(),
                command: s.command.clone(),
                timeout_seconds: s.timeout_seconds,
                environment: s.environment.clone(),
                dependencies: s.dependencies.clone(),
                status: CoreStepStatus::Pending,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            }).collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let updated = self.engine
            .update_pipeline(&pipeline)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(self.pipeline_to_proto(&updated)))
    }

    async fn delete_pipeline(
        &self,
        request: Request<DeletePipelineRequest>,
    ) -> Result<Response<proto::Empty>, Status> {
        let req = request.into_inner();
        self.engine
            .delete_pipeline(&req.id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(Empty {}))
    }

    async fn list_pipelines(
        &self,
        request: Request<ListPipelinesRequest>,
    ) -> Result<Response<ListPipelinesResponse>, Status> {
        let req = request.into_inner();
        let (pipelines, total) = self.engine
            .list_pipelines(
                req.page.try_into().map_err(|e: std::num::TryFromIntError| Status::internal(e.to_string()))?,
                req.limit.try_into().map_err(|e: std::num::TryFromIntError| Status::internal(e.to_string()))?,
                if req.filter.is_empty() { None } else { Some(req.filter) }
            )
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(ListPipelinesResponse {
            items: pipelines.into_iter().map(|p| self.pipeline_to_proto(&p)).collect(),
            total: total.try_into().unwrap_or(0),
            page: req.page,
            limit: req.limit,
        }))
    }

    async fn trigger_build(
        &self,
        request: Request<TriggerBuildRequest>,
    ) -> Result<Response<ProtoBuild>, Status> {
        let req = request.into_inner();
        let build = self.engine
            .trigger_build(&req.pipeline_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(self.build_to_proto(&build)))
    }

    async fn get_build(
        &self,
        request: Request<GetBuildRequest>,
    ) -> Result<Response<ProtoBuild>, Status> {
        let req = request.into_inner();
        let build = self.engine
            .get_build(&req.id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(self.build_to_proto(&build)))
    }

    async fn cancel_build(
        &self,
        request: Request<CancelBuildRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        self.engine
            .cancel_build(&req.id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        Ok(Response::new(Empty {}))
    }

    async fn list_builds(
        &self,
        request: Request<ListBuildsRequest>,
    ) -> Result<Response<ListBuildsResponse>, Status> {
        let req = request.into_inner();
        let response = self.engine
            .list_builds(Request::new(ListBuildsRequest {
                page: req.page,
                limit: req.limit,
                filter: req.filter,
                pipeline_id: req.pipeline_id,
                sort: req.sort,
            }))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(response)
    }

    async fn get_build_logs(
        &self,
        request: Request<GetBuildLogsRequest>,
    ) -> Result<Response<BuildLogs>, Status> {
        let req = request.into_inner();
        let logs = self.engine
            .get_build_logs(Request::new(GetBuildLogsRequest {
                build_id: req.build_id,
            }))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let log_entries = logs
            .into_inner()
            .logs
            .into_iter()
            .map(|log| proto::BuildLog {
                step_id: log.step_id,
                content: log.content,
                timestamp: DateTime::parse_from_rfc3339(&log.timestamp)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or(log.timestamp),
                })
            .collect::<Vec<_>>();
        
        Ok(Response::new(proto::BuildLogs {
            logs: log_entries,
        }))
    }

    async fn download_artifact(
        &self,
        request: Request<DownloadArtifactRequest>,
    ) -> Result<Response<Self::DownloadArtifactStream>, Status> {
        let (tx, rx) = mpsc::channel(128);
        let req = request.into_inner();
        
        // Create a stream that sends chunks of the artifact
        let stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream) as Self::DownloadArtifactStream))
    }

    async fn upload_artifact(
        &self,
        request: Request<Streaming<UploadArtifactRequest>>,
    ) -> Result<Response<Artifact>, Status> {
        let mut stream = request.into_inner();
        
        // Process the incoming stream of artifact chunks
        while let Some(chunk) = stream.next().await {
            let _chunk = chunk.map_err(|e| Status::internal(e.to_string()))?;
            // TODO: Implement artifact storage
        }
        
        Ok(Response::new(proto::Artifact {
            id: Uuid::new_v4().to_string(),
            name: "artifact".to_string(),
            size: 0,
            build_id: Uuid::new_v4().to_string(),
            path: "artifact".to_string(),
            content_type: "application/octet-stream".to_string(),
            metadata: HashMap::new(),
        }))
    }

    async fn list_artifacts(
        &self,
        request: Request<ListArtifactsRequest>,
    ) -> Result<Response<ListArtifactsResponse>, Status> {
        let _req = request.into_inner();
        
        // TODO: Implement artifact listing
        Ok(Response::new(proto::ListArtifactsResponse {
            items: vec![],
        }))
    }

    async fn subscribe_to_step_updates(
        &self,
        request: Request<proto::SubscribeToStepUpdatesRequest>,
    ) -> Result<Response<Self::SubscribeToStepUpdatesStream>, Status> {
        let (tx, rx) = mpsc::channel(128);
        let mut step_updates = self.engine.subscribe_to_updates();
        
        tokio::spawn(async move {
            while let Ok(update) = step_updates.recv().await {
                let response = proto::StepStatusUpdateResponse {
                    build_id: update.build_id.to_string(),
                    step_name: update.step_name,
                    status: update.status.into(),
                };
                
                if tx.send(Ok(response)).await.is_err() {
                    break;
                }
            }
        });
        
        let stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
}

impl From<ProtoPipelineStatus> for CorePipelineStatus {
    fn from(status: ProtoPipelineStatus) -> Self {
        match status {
            ProtoPipelineStatus::Unspecified => CorePipelineStatus::Unspecified,
            ProtoPipelineStatus::Pending => CorePipelineStatus::Pending,
            ProtoPipelineStatus::Running => CorePipelineStatus::Running,
            ProtoPipelineStatus::Completed => CorePipelineStatus::Completed,
            ProtoPipelineStatus::Failed => CorePipelineStatus::Failed,
        }
    }
}

impl From<CorePipelineStatus> for ProtoPipelineStatus {
    fn from(status: CorePipelineStatus) -> Self {
        match status {
            CorePipelineStatus::Unspecified => ProtoPipelineStatus::Unspecified,
            CorePipelineStatus::Pending => ProtoPipelineStatus::Pending,
            CorePipelineStatus::Running => ProtoPipelineStatus::Running,
            CorePipelineStatus::Completed => ProtoPipelineStatus::Completed,
            CorePipelineStatus::Failed => ProtoPipelineStatus::Failed,
        }
    }
}

impl From<ProtoBuildStatus> for CoreBuildStatus {
    fn from(status: ProtoBuildStatus) -> Self {
        match status {
            ProtoBuildStatus::Unspecified => CoreBuildStatus::Unspecified,
            ProtoBuildStatus::Pending => CoreBuildStatus::Pending,
            ProtoBuildStatus::Running => CoreBuildStatus::Running,
            ProtoBuildStatus::Success => CoreBuildStatus::Success,
            ProtoBuildStatus::Failed => CoreBuildStatus::Failed,
            ProtoBuildStatus::Cancelled => CoreBuildStatus::Cancelled,
        }
    }
}

impl From<CoreBuildStatus> for ProtoBuildStatus {
    fn from(status: CoreBuildStatus) -> Self {
        match status {
            CoreBuildStatus::Unspecified => ProtoBuildStatus::Unspecified,
            CoreBuildStatus::Pending => ProtoBuildStatus::Pending,
            CoreBuildStatus::Running => ProtoBuildStatus::Running,
            CoreBuildStatus::Success => ProtoBuildStatus::Success,
            CoreBuildStatus::Failed => ProtoBuildStatus::Failed,
            CoreBuildStatus::Cancelled => ProtoBuildStatus::Cancelled,
            CoreBuildStatus::TimedOut => ProtoBuildStatus::Failed,
        }
    }
}

impl From<ProtoStepStatus> for CoreStepStatus {
    fn from(status: ProtoStepStatus) -> Self {
        match status {
            ProtoStepStatus::Unspecified => CoreStepStatus::Unspecified,
            ProtoStepStatus::Pending => CoreStepStatus::Pending,
            ProtoStepStatus::Running => CoreStepStatus::Running,
            ProtoStepStatus::Success => CoreStepStatus::Success,
            ProtoStepStatus::Failed => CoreStepStatus::Failed,
            ProtoStepStatus::Cancelled => CoreStepStatus::Cancelled,
            ProtoStepStatus::TimedOut => CoreStepStatus::TimedOut,
            ProtoStepStatus::Skipped => CoreStepStatus::Skipped,
        }
    }
}

impl From<CoreStepStatus> for ProtoStepStatus {
    fn from(status: CoreStepStatus) -> Self {
        match status {
            CoreStepStatus::Unspecified => ProtoStepStatus::Unspecified,
            CoreStepStatus::Pending => ProtoStepStatus::Pending,
            CoreStepStatus::Running => ProtoStepStatus::Running,
            CoreStepStatus::Success => ProtoStepStatus::Success,
            CoreStepStatus::Failed => ProtoStepStatus::Failed,
            CoreStepStatus::Cancelled => ProtoStepStatus::Cancelled,
            CoreStepStatus::TimedOut => ProtoStepStatus::TimedOut,
            CoreStepStatus::Skipped => ProtoStepStatus::Skipped,
        }
    }
}