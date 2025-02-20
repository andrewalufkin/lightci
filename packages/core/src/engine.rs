use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, broadcast};
use crate::git::{GitManager, GitConfig};
use crate::workspace::FileSystemWorkspaceManager;
use crate::models::{Pipeline, Build, Step, PipelineStatus, BuildStatus, EngineError, StepResult, StepStatus};
use crate::db::Database;
use crate::executors::Executor;
use uuid::Uuid;
use chrono::Utc;
use tokio::task::JoinSet;
use log::{info, error, debug};
use thiserror::Error;
use std::collections::{HashMap, HashSet};
use tonic::{Request, Response, Status, Streaming};
use crate::grpc::proto::{self, CreatePipelineRequest, GetPipelineRequest, UpdatePipelineRequest, DeletePipelineRequest,
    ListPipelinesRequest, ListPipelinesResponse, TriggerBuildRequest, GetBuildRequest,
    CancelBuildRequest, ListBuildsRequest, ListBuildsResponse, GetBuildLogsRequest,
    UploadArtifactRequest, DownloadArtifactRequest, DownloadArtifactResponse,
    ListArtifactsRequest, ListArtifactsResponse, Empty, BuildLogs, Artifact, CreateBuildRequest as ProtoCreateBuildRequest,
    StepResult as ProtoStepResult,
};
use crate::grpc::proto::engine_service_server::EngineService;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use std::pin::Pin;
use tokio::sync::Mutex;
use futures::Stream;
use crate::executors::LocalExecutor;
use crate::config::Config;
use crate::artifact::ArtifactStore;
use crate::models::StepResult as ModelStepResult;

#[derive(Clone)]
pub struct StepStatusUpdate {
    pub build_id: Uuid,
    pub step_name: String,
    pub status: StepStatus,
}

pub struct PipelineEngine {
    executor: Box<dyn Executor>,
    db: Arc<Mutex<Database>>,
    running_pipelines: Arc<RwLock<HashMap<Uuid, Vec<ModelStepResult>>>>,
    workspace_manager: Arc<FileSystemWorkspaceManager>,
    git_manager: Arc<GitManager>,
    status_tx: broadcast::Sender<StepStatusUpdate>,
}

impl Clone for PipelineEngine {
    fn clone(&self) -> Self {
        Self {
            executor: self.executor.clone_box(),
            db: Arc::clone(&self.db),
            running_pipelines: Arc::clone(&self.running_pipelines),
            workspace_manager: Arc::clone(&self.workspace_manager),
            git_manager: Arc::clone(&self.git_manager),
            status_tx: self.status_tx.clone(),
        }
    }
}

impl PipelineEngine {
    pub async fn new(executor: Box<dyn Executor>, db: Arc<Database>, workspace_root: PathBuf) -> Result<Self, EngineError> {
        let git_config = GitConfig {
            timeout: Duration::from_secs(300),
            ssh_key_path: None,
            username: Some("git".to_string()),
            password: None,
        };
        
        let git_manager = Arc::new(GitManager::new(git_config));
        let workspace_manager = Arc::new(FileSystemWorkspaceManager::new(workspace_root).await?);
        let (status_tx, _) = broadcast::channel(100); // Buffer size of 100 messages
        
        Ok(Self {
            executor,
            db: Arc::new(Mutex::new((*db).clone())),
            running_pipelines: Arc::new(RwLock::new(HashMap::new())),
            workspace_manager,
            git_manager,
            status_tx,
        })
    }

    pub fn subscribe_to_updates(&self) -> broadcast::Receiver<StepStatusUpdate> {
        self.status_tx.subscribe()
    }

    async fn update_step_status(&self, build_id: Uuid, step_name: String, status: StepStatus) {
        // Broadcast the status update
        let update = StepStatusUpdate {
            build_id,
            step_name: step_name.clone(),
            status,
        };
        
        if let Err(e) = self.status_tx.send(update) {
            error!("Failed to broadcast step status update: {}", e);
        }
    }

    async fn execute_pipeline(&self, pipeline: Pipeline) -> Result<Vec<ModelStepResult>, EngineError> {
        let build_id = Uuid::new_v4(); // Generate a build ID
        
        // Create a build for this pipeline execution
        let build = Build {
            id: build_id.to_string(),
            pipeline_id: pipeline.id.clone(),
            branch: pipeline.default_branch.clone(),
            commit: "HEAD".to_string(),
            status: BuildStatus::Running,
            started_at: Some(Utc::now()),
            completed_at: None,
            parameters: HashMap::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        
        // Update pipeline status in database
        let mut pipeline = pipeline.clone();
        pipeline.status = PipelineStatus::Running;
        let db = self.db.lock().await;
        db.update_pipeline(&pipeline).await.map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        let mut execution = PipelineExecution::new(pipeline.clone(), self.executor.clone_box(), build_id, self.status_tx.clone());
        let results = execution.execute(&build).await?;

        // Update pipeline status based on results
        pipeline.status = if results.iter().any(|r| r.status == StepStatus::Failed) {
            PipelineStatus::Failed
        } else {
            PipelineStatus::Completed
        };
        db.update_pipeline(&pipeline).await.map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        Ok(results)
    }

    pub async fn get_pipeline(&self, id: &str) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.get_pipeline(id).await.map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn list_pipelines(&self, page: i32, limit: i32, _filter: Option<String>) -> Result<(Vec<Pipeline>, i64), EngineError> {
        let db = self.db.lock().await;
        let pipelines = db.list_pipelines(limit as i64, ((page - 1) * limit) as i64)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;
        Ok((pipelines.clone(), pipelines.len() as i64))
    }

    pub async fn create_pipeline(&self, pipeline: Pipeline) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.create_pipeline(pipeline.clone())
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn update_pipeline(&self, pipeline: &Pipeline) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.update_pipeline(pipeline)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn delete_pipeline(&self, id: &str) -> Result<(), EngineError> {
        let db = self.db.lock().await;
        db.delete_pipeline(id)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn create_build(&self, req: &ProtoCreateBuildRequest) -> Result<Build, EngineError> {
        let build = Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: req.pipeline_id.clone(),
            branch: req.branch.clone(),
            commit: req.commit.clone(),
            status: BuildStatus::Pending,
            started_at: None,
            completed_at: None,
            parameters: req.parameters.clone(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let db = self.db.lock().await;
        db.create_build(build.clone())
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn get_build(&self, id: &str) -> Result<Build, EngineError> {
        let db = self.db.lock().await;
        db.get_build(id)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn cancel_build(&self, id: &str) -> Result<(), EngineError> {
        let _build_id = Uuid::parse_str(id)
            .map_err(|e| EngineError::ValidationError(e.to_string()))?;
        
        let db = self.db.lock().await;
        let mut build = db.get_build(id).await?;
        
        if build.status == BuildStatus::Running || build.status == BuildStatus::Pending {
            build.status = BuildStatus::Cancelled;
            build.completed_at = Some(Utc::now());
            db.update_build(&build).await?;
        }
        
        Ok(())
    }

    pub async fn trigger_build(&self, pipeline_id: &str) -> Result<Build, EngineError> {
        let pipeline = self.get_pipeline(pipeline_id).await?;
        
        let build = Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: pipeline_id.to_string(),
            branch: pipeline.default_branch.clone(),
            commit: "HEAD".to_string(),
            status: BuildStatus::Pending,
            started_at: None,
            completed_at: None,
            parameters: HashMap::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let create_request = ProtoCreateBuildRequest {
            pipeline_id: build.pipeline_id.clone(),
            branch: build.branch.clone(),
            commit: build.commit.clone(),
            parameters: build.parameters.clone(),
        };

        let build = self.create_build(&create_request).await?;
        let build_clone = build.clone();
        let engine = self.clone();

        tokio::spawn(async move {
            if let Err(e) = engine.execute_build(&build_clone).await {
                error!("Failed to execute build: {}", e);
            }
        });

        Ok(build)
    }

    pub async fn update_build(&self, build: &Build) -> Result<Build, EngineError> {
        let db = self.db.lock().await;
        db.update_build(build).await.map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn execute_build(&self, build: &Build) -> Result<(), EngineError> {
        let pipeline = self.get_pipeline(&build.pipeline_id).await?;
        let mut build_clone = build.clone();
        build_clone.status = BuildStatus::Running;
        
        let db = self.db.lock().await;
        db.update_build(&build_clone)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        let mut execution = PipelineExecution::new(pipeline.clone(), self.executor.clone_box(), Uuid::parse_str(&build.id).unwrap(), self.status_tx.clone());
        let results = execution.execute(&build_clone).await?;

        // Update build status based on results
        build_clone.status = if results.iter().any(|r| r.status == StepStatus::Failed) {
            BuildStatus::Failed
        } else {
            BuildStatus::Success
        };
        build_clone.completed_at = Some(Utc::now());

        db.update_build(&build_clone)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        Ok(())
    }

    fn pipeline_to_proto(&self, pipeline: &Pipeline) -> proto::Pipeline {
        proto::Pipeline {
            id: pipeline.id.clone(),
            name: pipeline.name.clone(),
            repository: pipeline.repository.clone(),
            workspace_id: pipeline.workspace_id.clone(),
            description: pipeline.description.clone().unwrap_or_default(),
            default_branch: pipeline.default_branch.clone(),
            status: pipeline.status as i32,
            steps: pipeline.steps.iter().map(|s| proto::Step {
                id: s.id.clone(),
                name: s.name.clone(),
                command: s.command.clone(),
                timeout_seconds: s.timeout_seconds,
                environment: s.environment.clone(),
                dependencies: s.dependencies.clone(),
            }).collect(),
            created_at: pipeline.created_at.to_rfc3339(),
            updated_at: pipeline.updated_at.to_rfc3339(),
        }
    }
}

struct PipelineExecution {
    pipeline: Pipeline,
    executor: Box<dyn Executor>,
    build_id: Uuid,
    status_tx: broadcast::Sender<StepStatusUpdate>,
    results: Vec<ModelStepResult>,
    executing_steps: HashSet<String>,
}

impl PipelineExecution {
    fn new(pipeline: Pipeline, executor: Box<dyn Executor>, build_id: Uuid, status_tx: broadcast::Sender<StepStatusUpdate>) -> Self {
        Self {
            pipeline,
            executor,
            build_id,
            status_tx,
            results: Vec::new(),
            executing_steps: HashSet::new(),
        }
    }
    
    async fn execute(&mut self, build: &Build) -> Result<Vec<ModelStepResult>, EngineError> {
        let graph = self.build_dependency_graph()?;
    
        let mut ready_steps: HashSet<String> = self.pipeline.steps
            .iter()
            .filter(|step| step.dependencies.is_empty())
            .map(|step| step.id.to_string())
            .collect();
    
        if !self.pipeline.steps.is_empty() && ready_steps.is_empty() {
            return Err(EngineError::ConfigError(
                "Pipeline has no entry points (all steps have dependencies)".to_string(),
            ));
        }
    
        while !ready_steps.is_empty() || !self.executing_steps.is_empty() {
            let executable_steps: Vec<String> = ready_steps
                .iter()
                .filter(|id| !self.executing_steps.contains(*id))
                .cloned()
                .collect();
    
            if !executable_steps.is_empty() {
                let mut join_set = JoinSet::new();
                
                // Start all executable steps in parallel
                for step_id in executable_steps {
                    self.executing_steps.insert(step_id.clone());
                    ready_steps.remove(&step_id);

                    let step = self.pipeline.steps
                        .iter()
                        .find(|s| s.id.to_string() == step_id)
                        .unwrap()
                        .clone();
                    
                    let executor = self.executor.clone_box();
                    let build = build.clone();
                    let step_id_clone = step_id.clone();
                    
                    // Spawn each step execution as a separate task
                    join_set.spawn(async move {
                        let execution_result = executor.execute(&step, &build).await;
                        (step_id_clone, execution_result)
                    });
                }

                // Wait for all spawned tasks to complete
                while let Some(result) = join_set.join_next().await {
                    let (step_id, execution_result) = result.expect("Task failed");
                    
                    let result_index = self.results
                        .iter()
                        .position(|r| r.step_id.to_string() == step_id)
                        .unwrap();

                    match execution_result {
                        Ok(result) => {
                            let model_result = ModelStepResult {
                                step_id: result.step_id,
                                status: result.status,
                                output: result.output,
                                error: result.error,
                                started_at: result.started_at,
                                completed_at: result.completed_at,
                                exit_code: result.exit_code,
                            };
                            self.results[result_index] = model_result;
                            
                            if let Some(dependents) = graph.get(&step_id) {
                                for dependent in dependents {
                                    let dependent_step = self.pipeline.steps
                                        .iter()
                                        .find(|s| s.id.to_string() == *dependent)
                                        .unwrap();

                                    let all_dependencies_complete = dependent_step.dependencies
                                        .iter()
                                        .all(|dep_id| {
                                            self.results
                                                .iter()
                                                .any(|r| r.step_id.to_string() == *dep_id && r.status == StepStatus::Success)
                                        });

                                    if all_dependencies_complete {
                                        ready_steps.insert(dependent.clone());
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            self.results[result_index].status = StepStatus::Failed;
                            self.results[result_index].error = err.to_string();
                            self.results[result_index].completed_at = Some(Utc::now());
                            
                            if let Some(dependents) = graph.get(&step_id) {
                                for dependent in dependents {
                                    PipelineExecution::mark_step_and_dependents_skipped(dependent, &graph, &mut self.results);
                                }
                            }
                        }
                    }

                    self.executing_steps.remove(&step_id);
                }
            }
    
            if self.executing_steps.is_empty() && ready_steps.is_empty() {
                let completed_steps: HashSet<_> = self.results
                    .iter()
                    .filter(|r| matches!(r.status, StepStatus::Success | StepStatus::Failed | StepStatus::Skipped))
                    .map(|r| r.step_id.to_string())
                    .collect();
    
                let all_steps: HashSet<_> = self.pipeline.steps
                    .iter()
                    .map(|s| s.id.to_string())
                    .collect();
    
                if completed_steps != all_steps {
                    let missing_steps: Vec<_> = all_steps
                        .difference(&completed_steps)
                        .collect();
                    
                    return Err(EngineError::ConfigError(
                        format!("Steps {:?} were never executed. Possible dependency issue.", missing_steps)
                    ));
                }
            }
    
            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        }
    
        Ok(self.results.clone())
    }

    fn mark_step_and_dependents_skipped(
        step_id: &str,
        graph: &HashMap<String, Vec<String>>,
        results: &mut Vec<ModelStepResult>,
    ) {
        let result = ModelStepResult {
            step_id: Uuid::parse_str(step_id).unwrap_or_else(|_| Uuid::new_v4()).to_string(),
            status: StepStatus::Skipped,
            output: String::new(),
            error: String::new(),
            started_at: Some(Utc::now()),
            completed_at: Some(Utc::now()),
            exit_code: None,
        };
        results.push(result);

        if let Some(dependents) = graph.get(step_id) {
            for dependent in dependents {
                if !results.iter().any(|r| r.step_id.to_string() == *dependent) {
                    PipelineExecution::mark_step_and_dependents_skipped(dependent, graph, results);
                }
            }
        }
    }

    fn build_dependency_graph(&self) -> Result<HashMap<String, Vec<String>>, EngineError> {
        let mut graph: HashMap<String, Vec<String>> = HashMap::new();
        
        // Initialize empty vectors for all steps
        for step in &self.pipeline.steps {
            graph.insert(step.id.to_string(), Vec::new());
        }
        
        // Build the graph: map each step to the steps that depend on it
        for step in &self.pipeline.steps {
            // First verify all dependencies exist
            for dep_id in &step.dependencies {
                if !self.pipeline.steps.iter().any(|s| s.id.to_string() == *dep_id) {
                    return Err(EngineError::ConfigError(
                        format!("Step {} depends on non-existent step {}", step.id, dep_id)
                    ));
                }
                // Add this step as a dependent of its dependency
                graph.get_mut(dep_id)
                    .expect("Step should exist in graph")
                    .push(step.id.to_string());
            }
        }
    
        // Check for cycles starting from ALL nodes, not just root nodes
        let mut visited = HashSet::new();
        let mut stack = HashSet::new();
    
        // Check for cycles starting from each node
        for step in &self.pipeline.steps {
            // Clear the stack for each new starting point, but keep the visited set
            stack.clear();
            if self.has_cycle(&step.id.to_string(), &graph, &mut visited, &mut stack)? {
                return Err(EngineError::ConfigError(
                    format!("Circular dependency detected starting from step {}", step.id)
                ));
            }
        }
    
        Ok(graph)
    }

    fn has_cycle(
        &self,
        node: &str,
        graph: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        stack: &mut HashSet<String>,
    ) -> Result<bool, EngineError> {
        if stack.contains(node) {
            return Ok(true);
        }
        if visited.contains(node) {
            return Ok(false);
        }
    
        stack.insert(node.to_string());
    
        if let Some(dependents) = graph.get(node) {
            for dependent in dependents {
                if self.has_cycle(dependent, graph, visited, stack)? {
                    return Ok(true);
                }
            }
        }
    
        stack.remove(node);
        visited.insert(node.to_string());
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Step;
    use std::collections::HashMap;
    use uuid::Uuid;
    use async_trait::async_trait;
    use tokio::sync::Mutex;
    use std::sync::Arc;

    // Mock executor for testing
    struct MockExecutor {
        executed_steps: Arc<Mutex<Vec<String>>>,
        should_fail: Arc<Mutex<HashMap<String, bool>>>,
        execution_delay: std::time::Duration,
    }

    impl MockExecutor {
        fn new(execution_delay: std::time::Duration) -> Self {
            Self {
                executed_steps: Arc::new(Mutex::new(Vec::new())),
                should_fail: Arc::new(Mutex::new(HashMap::new())),
                execution_delay,
            }
        }

        async fn get_executed_steps(&self) -> Vec<String> {
            self.executed_steps.lock().await.clone()
        }

        async fn set_step_failure(&self, step_id: &str) {
            self.should_fail.lock().await.insert(step_id.to_string(), true);
        }
    }

    #[async_trait]
    impl Executor for MockExecutor {
        fn clone_box(&self) -> Box<dyn Executor> {
            Box::new(Self {
                executed_steps: Arc::clone(&self.executed_steps),
                should_fail: Arc::clone(&self.should_fail),
                execution_delay: self.execution_delay,
            })
        }

        async fn execute(&self, step: &Step, build: &Build) -> Result<StepResult, String> {
            tokio::time::sleep(self.execution_delay).await;
            
            let mut executed = self.executed_steps.lock().await;
            executed.push(step.id.clone());
            
            let should_fail = self.should_fail.lock().await;
            if should_fail.get(&step.id).copied().unwrap_or(false) {
                return Ok(StepResult {
                    step_id: step.id.clone(),
                    status: StepStatus::Failed,
                    output: String::new(),
                    error: String::new(),
                    started_at: Some(Utc::now()),
                    completed_at: Some(Utc::now()),
                    exit_code: Some(1),
                });
            }

            Ok(StepResult {
                step_id: step.id.clone(),
                status: StepStatus::Success,
                output: format!("Executed step {}", step.id),
                error: String::new(),
                started_at: Some(Utc::now()),
                completed_at: Some(Utc::now()),
                exit_code: Some(0),
            })
        }
    }

    #[tokio::test]
    async fn test_simple_pipeline() {
        let executor = Arc::new(MockExecutor::new(Duration::from_millis(100)));
        let db = Database::new("sqlite::memory:").await.expect("Failed to create database");
        let engine = PipelineEngine::new(Box::new(executor.clone()), Arc::new(db), PathBuf::new()).await.expect("Failed to create PipelineEngine");

        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: "test-pipeline".to_string(),
            repository: "https://github.com/test/repo.git".to_string(),
            workspace_id: "test-workspace".to_string(),
            description: Some("Test pipeline".to_string()),
            default_branch: "main".to_string(),
            status: PipelineStatus::Pending,
            steps: vec![
                Step {
                    id: "step1".to_string(),
                    name: "Step 1".to_string(),
                    command: "echo 'Step 1'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec![],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Step {
                    id: "step2".to_string(),
                    name: "Step 2".to_string(),
                    command: "echo 'Step 2'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["step1".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                }
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let results = engine.execute_pipeline(pipeline).await.unwrap();
        
        // Verify execution order
        let executed_steps = executor.get_executed_steps().await;
        assert_eq!(executed_steps, vec!["step1", "step2"]);
        
        // Verify results
        assert_eq!(results.len(), 2);
        assert!(matches!(results[0].status, StepStatus::Success));
        assert!(matches!(results[1].status, StepStatus::Success));
    }

    #[tokio::test]
    async fn test_parallel_execution() {
        let executor = Arc::new(MockExecutor::new(Duration::from_millis(100)));
        let db = Database::new("sqlite::memory:").await.expect("Failed to create database");
        let engine = PipelineEngine::new(Box::new(executor.clone()), Arc::new(db), PathBuf::new()).await.expect("Failed to create PipelineEngine");

        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: "parallel-pipeline".to_string(),
            repository: "https://github.com/test/repo.git".to_string(),
            workspace_id: "test-workspace".to_string(),
            description: Some("Parallel pipeline".to_string()),
            default_branch: "main".to_string(),
            status: PipelineStatus::Pending,
            steps: vec![
                Step {
                    id: "step1".to_string(),
                    name: "Step 1".to_string(),
                    command: "echo 'step1'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec![],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Step {
                    id: "step2".to_string(),
                    name: "Step 2".to_string(),
                    command: "echo 'step2'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec![],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Step {
                    id: "step3".to_string(),
                    name: "Step 3".to_string(),
                    command: "echo 'step3'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["step1".to_string(), "step2".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let start_time = std::time::Instant::now();
        let results = engine.execute_pipeline(pipeline).await.unwrap();
        let execution_time = start_time.elapsed();

        // Verify parallel execution time (should be around 200ms, not 300ms)
        assert!(execution_time < std::time::Duration::from_millis(250));
        
        // Verify all steps completed successfully
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| matches!(r.status, StepStatus::Success)));
    }

    #[tokio::test]
    async fn test_failure_propagation() {
        let executor = Arc::new(MockExecutor::new(Duration::from_millis(100)));
        let db = Database::new("sqlite::memory:").await.expect("Failed to create database");
        let engine = PipelineEngine::new(Box::new(executor.clone()), Arc::new(db), PathBuf::new()).await.expect("Failed to create PipelineEngine");

        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: "failure-pipeline".to_string(),
            repository: "https://github.com/test/repo.git".to_string(),
            workspace_id: "test-workspace".to_string(),
            description: Some("Failure pipeline".to_string()),
            default_branch: "main".to_string(),
            status: PipelineStatus::Pending,
            steps: vec![
                Step {
                    id: "step1".to_string(),
                    name: "Step 1".to_string(),
                    command: "echo 'step1'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec![],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Step {
                    id: "step2".to_string(),
                    name: "Step 2".to_string(),
                    command: "echo 'step2'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["step1".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let results = engine.execute_pipeline(pipeline).await.unwrap();
        
        // Verify failure status
        assert_eq!(results.len(), 2);
        assert!(matches!(results[0].status, StepStatus::Failed));
        assert!(matches!(results[1].status, StepStatus::Skipped));
    }

    #[tokio::test]
    async fn test_circular_dependency_detection() {
        let executor = Arc::new(MockExecutor::new(Duration::from_millis(100)));
        let db = Database::new("sqlite::memory:").await.expect("Failed to create database");
        let engine = PipelineEngine::new(Box::new(executor.clone()), Arc::new(db), PathBuf::new()).await.expect("Failed to create PipelineEngine");

        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: "circular-pipeline".to_string(),
            repository: "https://github.com/test/repo.git".to_string(),
            workspace_id: "test-workspace".to_string(),
            description: Some("Circular pipeline".to_string()),
            default_branch: "main".to_string(),
            status: PipelineStatus::Pending,
            steps: vec![
                Step {
                    id: "step1".to_string(),
                    name: "Step 1".to_string(),
                    command: "echo 'step1'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["step2".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
                Step {
                    id: "step2".to_string(),
                    name: "Step 2".to_string(),
                    command: "echo 'step2'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["step1".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let result = engine.execute_pipeline(pipeline).await;
        assert!(matches!(result, Err(EngineError::ConfigError(_))));
    }

    #[tokio::test]
    async fn test_missing_dependency() {
        let executor = Arc::new(MockExecutor::new(Duration::from_millis(100)));
        let db = Database::new("sqlite::memory:").await.expect("Failed to create database");
        let engine = PipelineEngine::new(Box::new(executor.clone()), Arc::new(db), PathBuf::new()).await.expect("Failed to create PipelineEngine");

        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: "missing-dep-pipeline".to_string(),
            repository: "https://github.com/test/repo.git".to_string(),
            workspace_id: "test-workspace".to_string(),
            description: Some("Missing dependency pipeline".to_string()),
            default_branch: "main".to_string(),
            status: PipelineStatus::Pending,
            steps: vec![
                Step {
                    id: "step1".to_string(),
                    name: "Step 1".to_string(),
                    command: "echo 'step1'".to_string(),
                    timeout_seconds: 300,
                    environment: HashMap::new(),
                    dependencies: vec!["non-existent-step".to_string()],
                    status: StepStatus::Pending,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let result = engine.execute_pipeline(pipeline).await;
        assert!(matches!(result, Err(EngineError::ConfigError(_))));
    }
}

pub struct Engine {
    pub db: Arc<Mutex<Database>>,
    executor: Box<dyn Executor>,
    workspace_root: PathBuf,
    status_tx: broadcast::Sender<StepStatusUpdate>,
}

impl Engine {
    pub fn new(
        db: Database,
        executor: Box<dyn Executor>,
        workspace_root: PathBuf,
    ) -> Self {
        let (status_tx, _) = broadcast::channel(100); // Buffer size of 100 messages
        Self {
            db: Arc::new(Mutex::new(db)),
            executor,
            workspace_root,
            status_tx,
        }
    }

    pub async fn get_pipeline(&self, id: &str) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.get_pipeline(id).await.map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn list_pipelines(&self, page: i32, limit: i32, _filter: Option<String>) -> Result<(Vec<Pipeline>, i64), EngineError> {
        let db = self.db.lock().await;
        let pipelines = db.list_pipelines(limit as i64, ((page - 1) * limit) as i64)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;
        Ok((pipelines.clone(), pipelines.len() as i64))
    }

    pub async fn create_pipeline(&self, pipeline: Pipeline) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.create_pipeline(pipeline.clone())
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn update_pipeline(&self, pipeline: &Pipeline) -> Result<Pipeline, EngineError> {
        let db = self.db.lock().await;
        db.update_pipeline(pipeline)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn delete_pipeline(&self, id: &str) -> Result<(), EngineError> {
        let db = self.db.lock().await;
        db.delete_pipeline(id)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn subscribe_to_step_updates(&self) -> broadcast::Receiver<StepStatusUpdate> {
        self.status_tx.subscribe()
    }

    pub async fn execute_build(&self, build: &Build) -> Result<(), EngineError> {
        let pipeline = self.get_pipeline(&build.pipeline_id).await?;
        let mut build_clone = build.clone();
        build_clone.status = BuildStatus::Running;
        
        let db = self.db.lock().await;
        db.update_build(&build_clone)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        let mut execution = PipelineExecution::new(pipeline.clone(), self.executor.clone_box(), Uuid::parse_str(&build.id).unwrap(), self.status_tx.clone());
        let results = execution.execute(&build_clone).await?;

        // Update build status based on results
        build_clone.status = if results.iter().any(|r| r.status == StepStatus::Failed) {
            BuildStatus::Failed
        } else {
            BuildStatus::Success
        };
        build_clone.completed_at = Some(Utc::now());

        db.update_build(&build_clone)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;

        Ok(())
    }

    pub async fn create_build(&self, req: &ProtoCreateBuildRequest) -> Result<Build, EngineError> {
        let build = Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: req.pipeline_id.clone(),
            branch: req.branch.clone(),
            commit: req.commit.clone(),
            status: BuildStatus::Pending,
            started_at: None,
            completed_at: None,
            parameters: req.parameters.clone(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let db = self.db.lock().await;
        db.create_build(build.clone())
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn get_build(&self, id: &str) -> Result<Build, EngineError> {
        let db = self.db.lock().await;
        db.get_build(id)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn cancel_build(&self, id: &str) -> Result<(), EngineError> {
        let _build_id = Uuid::parse_str(id)
            .map_err(|e| EngineError::ValidationError(e.to_string()))?;
        
        let db = self.db.lock().await;
        let mut build = db.get_build(id).await?;
        
        if build.status == BuildStatus::Running || build.status == BuildStatus::Pending {
            build.status = BuildStatus::Cancelled;
            build.completed_at = Some(Utc::now());
            db.update_build(&build).await?;
        }
        
        Ok(())
    }

    pub async fn trigger_build(&self, pipeline_id: &str) -> Result<Build, EngineError> {
        let pipeline = self.get_pipeline(pipeline_id).await?;
        
        let build = Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: pipeline_id.to_string(),
            branch: pipeline.default_branch.clone(),
            commit: "HEAD".to_string(),
            status: BuildStatus::Pending,
            started_at: None,
            completed_at: None,
            parameters: HashMap::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let create_request = ProtoCreateBuildRequest {
            pipeline_id: build.pipeline_id.clone(),
            branch: build.branch.clone(),
            commit: build.commit.clone(),
            parameters: build.parameters.clone(),
        };

        let build = self.create_build(&create_request).await?;
        let build_clone = build.clone();
        let engine = self.clone();

        tokio::spawn(async move {
            if let Err(e) = engine.execute_build(&build_clone).await {
                error!("Failed to execute build: {}", e);
            }
        });

        Ok(build)
    }

    pub async fn update_build(&self, build: &Build) -> Result<Build, EngineError> {
        let db = self.db.lock().await;
        db.update_build(build).await.map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn list_builds(&self, page: i32, limit: i32, _filter: Option<String>) -> Result<(Vec<Build>, i64), EngineError> {
        let db = self.db.lock().await;
        let builds = db.list_builds(limit as i64, (page * limit) as i64)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))?;
        Ok((builds.clone(), builds.len() as i64))
    }
}

impl Clone for Engine {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            executor: self.executor.clone_box(),
            workspace_root: self.workspace_root.clone(),
            status_tx: self.status_tx.clone(),
        }
    }
}

pub use crate::models::CreateBuildRequest;

#[derive(Debug, Clone)]
pub struct BuildLog {
    pub build_id: String,
    pub step_id: String,
    pub content: String,
    pub timestamp: chrono::DateTime<Utc>,
}

#[tonic::async_trait]
impl EngineService for PipelineEngine {
    type DownloadArtifactStream = Pin<Box<dyn Stream<Item = Result<DownloadArtifactResponse, Status>> + Send + 'static>>;
    type SubscribeToStepUpdatesStream = Pin<Box<dyn Stream<Item = Result<proto::StepStatusUpdateResponse, Status>> + Send + 'static>>;

    async fn create_pipeline(
        &self,
        request: Request<CreatePipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        let pipeline = Pipeline {
            id: Uuid::new_v4().to_string(),
            name: req.name,
            repository: req.repository,
            workspace_id: req.workspace_id,
            description: Some(req.description),
            default_branch: req.default_branch,
            status: PipelineStatus::Pending,
            steps: req.steps.into_iter()
                .enumerate()
                .map(|(index, s)| Step {
                    id: format!("step-{}", index + 1),
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
        };

        match self.create_pipeline(pipeline.clone()).await {
            Ok(created) => Ok(Response::new(self.pipeline_to_proto(&created))),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_pipeline(
        &self,
        request: Request<GetPipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        match self.get_pipeline(&req.id).await {
            Ok(pipeline) => {
                let proto_pipeline = proto::Pipeline {
                    id: pipeline.id,
                    name: pipeline.name,
                    repository: pipeline.repository,
                    workspace_id: pipeline.workspace_id,
                    description: pipeline.description.unwrap_or_default(),
                    default_branch: pipeline.default_branch,
                    status: pipeline.status as i32,
                    steps: pipeline.steps.into_iter().map(|s| proto::Step {
                        id: s.id,
                        name: s.name,
                        command: s.command,
                        timeout_seconds: s.timeout_seconds,
                        environment: s.environment,
                        dependencies: s.dependencies,
                    }).collect(),
                    created_at: pipeline.created_at.to_rfc3339(),
                    updated_at: pipeline.updated_at.to_rfc3339(),
                };
                Ok(Response::new(proto_pipeline))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn update_pipeline(
        &self,
        request: Request<UpdatePipelineRequest>,
    ) -> Result<Response<proto::Pipeline>, Status> {
        let req = request.into_inner();
        let mut pipeline = self.get_pipeline(&req.id).await
            .map_err(|e| Status::internal(e.to_string()))?;
        
        pipeline.name = req.name;
        pipeline.repository = req.repository;
        pipeline.description = Some(req.description);
        pipeline.default_branch = req.default_branch;
        
        match self.update_pipeline(&pipeline).await {
            Ok(updated) => {
                let proto_pipeline = proto::Pipeline {
                    id: updated.id,
                    name: updated.name,
                    repository: updated.repository,
                    workspace_id: updated.workspace_id,
                    description: updated.description.unwrap_or_default(),
                    default_branch: updated.default_branch,
                    status: updated.status as i32,
                    steps: updated.steps.into_iter().map(|s| proto::Step {
                        id: s.id,
                        name: s.name,
                        command: s.command,
                        timeout_seconds: s.timeout_seconds,
                        environment: s.environment,
                        dependencies: s.dependencies,
                    }).collect(),
                    created_at: updated.created_at.to_rfc3339(),
                    updated_at: updated.updated_at.to_rfc3339(),
                };
                Ok(Response::new(proto_pipeline))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn delete_pipeline(
        &self,
        request: Request<DeletePipelineRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        match self.delete_pipeline(&req.id).await {
            Ok(_) => Ok(Response::new(Empty {})),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn list_pipelines(
        &self,
        request: Request<ListPipelinesRequest>,
    ) -> Result<Response<ListPipelinesResponse>, Status> {
        let req = request.into_inner();
        match self.list_pipelines(
            req.page.try_into().unwrap_or(0),
            req.limit.try_into().unwrap_or(10),
            None
        ).await {
            Ok((pipelines, total)) => {
                let items = pipelines.into_iter().map(|p| proto::Pipeline {
                    id: p.id,
                    name: p.name,
                    repository: p.repository,
                    workspace_id: p.workspace_id,
                    description: p.description.unwrap_or_default(),
                    default_branch: p.default_branch,
                    status: p.status as i32,
                    steps: p.steps.into_iter().map(|s| proto::Step {
                        id: s.id,
                        name: s.name,
                        command: s.command,
                        timeout_seconds: s.timeout_seconds,
                        environment: s.environment,
                        dependencies: s.dependencies,
                    }).collect(),
                    created_at: p.created_at.to_rfc3339(),
                    updated_at: p.updated_at.to_rfc3339(),
                }).collect();

                Ok(Response::new(ListPipelinesResponse {
                    items,
                    total: total as u32,
                    page: req.page,
                    limit: req.limit,
                }))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn trigger_build(
        &self,
        request: Request<TriggerBuildRequest>,
    ) -> Result<Response<proto::Build>, Status> {
        let req = request.into_inner();
        match self.trigger_build(&req.pipeline_id).await {
            Ok(build) => {
                let proto_build = proto::Build {
                    id: build.id,
                    pipeline_id: build.pipeline_id,
                    branch: build.branch,
                    commit: build.commit,
                    status: build.status as i32,
                    started_at: build.started_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    completed_at: build.completed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    parameters: build.parameters,
                };
                Ok(Response::new(proto_build))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_build(
        &self,
        request: Request<GetBuildRequest>,
    ) -> Result<Response<proto::Build>, Status> {
        let req = request.into_inner();
        match self.get_build(&req.id).await {
            Ok(build) => {
                let proto_build = proto::Build {
                    id: build.id,
                    pipeline_id: build.pipeline_id,
                    branch: build.branch,
                    commit: build.commit,
                    status: build.status as i32,
                    started_at: build.started_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    completed_at: build.completed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    parameters: build.parameters,
                };
                Ok(Response::new(proto_build))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn cancel_build(
        &self,
        request: Request<CancelBuildRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        match self.cancel_build(&req.id).await {
            Ok(_) => Ok(Response::new(Empty {})),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn list_builds(
        &self,
        request: Request<ListBuildsRequest>,
    ) -> Result<Response<ListBuildsResponse>, Status> {
        let req = request.into_inner();
        let page: i32 = req.page.try_into().unwrap_or(0);
        let limit: i32 = req.limit.try_into().unwrap_or(10);
        
        let db = self.db.lock().await;
        match db.list_builds(limit as i64, (page * limit) as i64).await {
            Ok(builds) => {
                let items = builds.iter().map(|b| proto::Build {
                    id: b.id.clone(),
                    pipeline_id: b.pipeline_id.clone(),
                    branch: b.branch.clone(),
                    commit: b.commit.clone(),
                    status: b.status as i32,
                    started_at: b.started_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    completed_at: b.completed_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
                    parameters: b.parameters.clone(),
                }).collect();

                Ok(Response::new(ListBuildsResponse {
                    items,
                    total: builds.len() as u32,
                    page: req.page,
                    limit: req.limit,
                }))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn get_build_logs(
        &self,
        request: Request<GetBuildLogsRequest>,
    ) -> Result<Response<BuildLogs>, Status> {
        let req = request.into_inner();
        let db = self.db.lock().await;
        match db.get_build_logs(&req.build_id).await {
            Ok(logs) => {
                let proto_logs = logs.into_iter().map(|log| proto::BuildLog {
                    step_id: log.step_id,
                    content: log.content,
                    timestamp: log.timestamp.to_rfc3339(),
                }).collect();
                Ok(Response::new(BuildLogs { logs: proto_logs }))
            },
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn upload_artifact(
        &self,
        _request: Request<Streaming<UploadArtifactRequest>>,
    ) -> Result<Response<Artifact>, Status> {
        // TODO: Implement artifact upload
        Err(Status::unimplemented("Not yet implemented"))
    }

    async fn download_artifact(
        &self,
        _request: Request<DownloadArtifactRequest>,
    ) -> Result<Response<Self::DownloadArtifactStream>, Status> {
        // TODO: Implement artifact download
        Err(Status::unimplemented("Not yet implemented"))
    }

    async fn list_artifacts(
        &self,
        _request: Request<ListArtifactsRequest>,
    ) -> Result<Response<ListArtifactsResponse>, Status> {
        // TODO: Implement artifact listing
        Ok(Response::new(ListArtifactsResponse { items: vec![] }))
    }

    async fn subscribe_to_step_updates(
        &self,
        _request: Request<proto::SubscribeToStepUpdatesRequest>,
    ) -> Result<Response<Self::SubscribeToStepUpdatesStream>, Status> {
        let (tx, rx) = mpsc::channel(128);
        let mut step_updates = self.subscribe_to_updates();
        
        tokio::spawn(async move {
            while let Ok(update) = step_updates.recv().await {
                let response = proto::StepStatusUpdateResponse {
                    build_id: update.build_id.to_string(),
                    step_name: update.step_name,
                    status: update.status as i32,
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

impl Engine {
    pub async fn update_build_status(&self, id: &str, status: BuildStatus) -> Result<Build, EngineError> {
        let build_id = Uuid::parse_str(id)
            .map_err(|e| EngineError::ValidationError(e.to_string()))?;
        
        let db = self.db.lock().await;
        db.update_build_status(id, status)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn update_step_status(&self, id: &str, status: StepStatus) -> Result<Step, EngineError> {
        let db = self.db.lock().await;
        db.update_step_status(id, status)
            .await
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }

    pub async fn get_build_logs(&self, build_id: &str) -> Result<Vec<BuildLog>, EngineError> {
        let db = self.db.lock().await;
        db.get_build_logs(build_id)
            .await
            .map(|logs| {
                logs.into_iter()
                    .map(|log| BuildLog {
                        build_id: build_id.to_string(),
                        step_id: log.step_id,
                        content: log.content,
                        timestamp: log.timestamp,
                    })
                    .collect()
            })
            .map_err(|e| EngineError::DatabaseError(e.to_string()))
    }
}

impl Engine {
    fn create_step_result(&self, step: &Step, output: String, status: StepStatus) -> StepResult {
        StepResult {
            step_id: step.id.clone(),
            status,
            output,
            error: String::new(),
            started_at: Some(Utc::now()),
            completed_at: Some(Utc::now()),
            exit_code: Some(0),
        }
    }
}