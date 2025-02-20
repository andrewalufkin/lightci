use crate::models::{Step, Build, EngineError, StepStatus, StepResult};
use async_trait::async_trait;
use std::path::PathBuf;
use tokio::{
    process::Command,
    time::{timeout, Duration},
};
use std::process::Stdio;
use std::sync::Arc;
use chrono::Utc;
use std::collections::HashMap;
use uuid::Uuid;

#[async_trait]
pub trait Executor: Send + Sync {
    fn clone_box(&self) -> Box<dyn Executor>;
    async fn execute(&self, step: &Step, build: &Build) -> Result<StepResult, String>;
}

pub struct DockerExecutor {
    pub docker_host: String,
}

impl DockerExecutor {
    pub fn new(docker_host: String) -> Self {
        Self { docker_host }
    }
}

#[async_trait]
impl Executor for DockerExecutor {
    fn clone_box(&self) -> Box<dyn Executor> {
        Box::new(self.clone())
    }

    async fn execute(&self, step: &Step, _build: &Build) -> Result<StepResult, String> {
        let started_at = Utc::now();

        let mut env_vars = HashMap::new();
        let env_str = serde_json::to_string(&step.environment)
            .map_err(|e| format!("Failed to serialize environment: {}", e))?;
        if let Ok(env_map) = serde_json::from_str::<HashMap<String, String>>(&env_str) {
            env_vars.extend(env_map);
        }

        let mut cmd = Command::new("docker");
        cmd.arg("run")
            .arg("--rm")
            .arg("-w")
            .arg(".")
            .arg("ubuntu:latest")
            .arg("bash")
            .arg("-c")
            .arg(&step.command);

        for (key, value) in env_vars {
            cmd.arg("-e").arg(format!("{}={}", key, value));
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let exit_code = output.status.code().unwrap_or(-1);

        let status = if exit_code == 0 {
            StepStatus::Success
        } else {
            StepStatus::Failed
        };

        Ok(StepResult {
            step_id: step.id.clone(),
            status,
            output: stdout,
            error: if stderr.is_empty() { String::new() } else { stderr },
            started_at: Some(started_at),
            completed_at: Some(Utc::now()),
            exit_code: Some(exit_code),
        })
    }
}

impl Clone for DockerExecutor {
    fn clone(&self) -> Self {
        Self {
            docker_host: self.docker_host.clone()
        }
    }
}

pub struct LocalExecutor {
    workspace_dir: PathBuf,
}

impl LocalExecutor {
    pub fn new(workspace_dir: PathBuf) -> Self {
        Self { workspace_dir }
    }
}

impl Clone for LocalExecutor {
    fn clone(&self) -> Self {
        Self {
            workspace_dir: self.workspace_dir.clone(),
        }
    }
}

#[async_trait]
impl Executor for LocalExecutor {
    fn clone_box(&self) -> Box<dyn Executor> {
        Box::new(self.clone())
    }

    async fn execute(&self, step: &Step, _build: &Build) -> Result<StepResult, String> {
        let started_at = Utc::now();
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(&step.command)
            .current_dir(&self.workspace_dir)
            .envs(&step.environment);

        let output = command
            .output()
            .await
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let exit_code = output.status.code().unwrap_or(-1);

        let status = if exit_code == 0 {
            StepStatus::Success
        } else {
            StepStatus::Failed
        };

        Ok(StepResult {
            step_id: step.id.clone(),
            status,
            output: stdout,
            error: if stderr.is_empty() { String::new() } else { stderr },
            started_at: Some(started_at),
            completed_at: Some(Utc::now()),
            exit_code: Some(exit_code),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::tempdir;
    use crate::models::BuildStatus;

    #[tokio::test]
    async fn test_local_executor() {
        let temp_dir = tempdir().unwrap();
        let executor = LocalExecutor::new(temp_dir.path().to_path_buf());

        let step = Step {
            id: Uuid::new_v4().to_string(),
            name: "test".to_string(),
            command: "echo 'Hello, World!'".to_string(),
            timeout_seconds: 30,
            environment: HashMap::new(),
            dependencies: Vec::new(),
            status: StepStatus::Pending,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let build = Build {
            id: Uuid::new_v4().to_string(),
            pipeline_id: Uuid::new_v4().to_string(),
            branch: "main".to_string(),
            commit: "abc123".to_string(),
            status: BuildStatus::Running,
            started_at: Some(Utc::now()),
            completed_at: None,
            parameters: HashMap::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let result = executor.execute(&step, &build).await.unwrap();
        assert_eq!(result.status, StepStatus::Success);
        assert_eq!(result.output.trim(), "Hello, World!");
        assert!(result.error.is_none());
        assert_eq!(result.exit_code, Some(0));
    }
}