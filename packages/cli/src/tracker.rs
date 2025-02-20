// packages/cli/src/tracker.rs

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct PipelineStatus {
    pub id: Uuid,
    pub name: String,
    pub state: ExecutionState,
    pub steps: HashMap<String, StepStatus>,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct StepStatus {
    pub name: String,
    pub state: ExecutionState,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionState {
    Pending,
    Running,
    Success,
    Failed,
    Cancelled,
}

pub struct ExecutionTracker {
    pipelines: Arc<RwLock<HashMap<Uuid, PipelineStatus>>>,
}

impl ExecutionTracker {
    pub fn new() -> Self {
        Self {
            pipelines: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_pipeline(&self, id: Uuid, name: String, steps: Vec<String>) -> PipelineStatus {
        let mut step_statuses = HashMap::new();
        for step in steps {
            step_statuses.insert(step.clone(), StepStatus {
                name: step,
                state: ExecutionState::Pending,
                start_time: None,
                end_time: None,
                exit_code: None,
                error: None,
            });
        }

        let status = PipelineStatus {
            id,
            name,
            state: ExecutionState::Pending,
            steps: step_statuses,
            start_time: Utc::now(),
            end_time: None,
        };

        self.pipelines.write().await.insert(id, status.clone());
        status
    }

    pub async fn update_step(&self, pipeline_id: Uuid, step: &str, update: StepStatusUpdate) {
        let mut pipelines = self.pipelines.write().await;
        if let Some(pipeline) = pipelines.get_mut(&pipeline_id) {
            if let Some(step_status) = pipeline.steps.get_mut(step) {
                update.apply(step_status);
                
                // Update pipeline state based on step states
                let all_completed = pipeline.steps.values()
                    .all(|s| matches!(s.state, ExecutionState::Success | ExecutionState::Failed));
                let any_failed = pipeline.steps.values()
                    .any(|s| matches!(s.state, ExecutionState::Failed));

                if all_completed {
                    pipeline.state = if any_failed {
                        ExecutionState::Failed
                    } else {
                        ExecutionState::Success
                    };
                    pipeline.end_time = Some(Utc::now());
                }
            }
        }
    }

    pub async fn get_status(&self, pipeline_id: &Uuid) -> Option<PipelineStatus> {
        self.pipelines.read().await.get(pipeline_id).cloned()
    }

    pub async fn get_all_statuses(&self) -> Vec<(Uuid, PipelineStatus)> {
        let guard = self.pipelines.read().await;
        guard.iter()
            .map(|(id, status)| (*id, status.clone()))
            .collect()
    }

    pub async fn list_active_pipelines(&self) -> Vec<PipelineStatus> {
        self.pipelines.read().await
            .values()
            .filter(|p| matches!(p.state, ExecutionState::Pending | ExecutionState::Running))
            .cloned()
            .collect()
    }

    pub async fn update_pipeline(&self, pipeline_id: Uuid, update: StepStatusUpdate) {
        let mut pipelines = self.pipelines.write().await;
        if let Some(pipeline) = pipelines.get_mut(&pipeline_id) {
            if let Some(state) = &update.state {
                pipeline.state = state.clone();
            }
            if let Some(end_time) = &update.end_time {
                pipeline.end_time = Some(*end_time);
            }
        }
    }
}

#[derive(Default)]
pub struct StepStatusUpdate {
    pub state: Option<ExecutionState>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

impl StepStatusUpdate {
    fn apply(&self, status: &mut StepStatus) {
        if let Some(state) = &self.state {
            status.state = state.clone();
        }
        if let Some(start_time) = &self.start_time {
            status.start_time = Some(*start_time);
        }
        if let Some(end_time) = &self.end_time {
            status.end_time = Some(*end_time);
        }
        if let Some(exit_code) = &self.exit_code {
            status.exit_code = Some(*exit_code);
        }
        if let Some(error) = &self.error {
            status.error = Some(error.clone());
        }
    }
}