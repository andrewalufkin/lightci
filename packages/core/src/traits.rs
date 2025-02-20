use async_trait::async_trait;
use uuid::Uuid;
use std::path::PathBuf;
use crate::models::EngineError;

#[async_trait]
pub trait WorkspaceManager {
    async fn create(&self, pipeline_id: Uuid) -> Result<PathBuf, EngineError>;
    async fn cleanup(&self, pipeline_id: Uuid) -> Result<(), EngineError>;
} 