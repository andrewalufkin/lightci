// src/config.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;
use crate::models::{Pipeline, Step, EngineError, ValidationError, PipelineStatus, StepStatus};
use chrono::{DateTime, Utc};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub workspace_dir: String,
    pub artifact_dir: String,
    pub pipeline: Pipeline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    /// Name of the pipeline
    pub name: String,
    /// Repository URL
    pub repository: String,
    /// Description of the pipeline
    pub description: Option<String>,
    /// Default branch for the pipeline
    pub default_branch: String,
    /// Pipeline steps
    pub steps: Vec<StepConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepConfig {
    /// Display name of the step
    pub name: String,
    /// Command to execute
    pub command: String,
    /// Step-specific environment variables
    pub environment: HashMap<String, String>,
    /// Steps that must complete before this one
    pub dependencies: Vec<String>,
    /// Maximum execution time in seconds
    pub timeout_seconds: u32,
}

impl Config {
    pub fn new(workspace_dir: PathBuf, artifact_dir: PathBuf) -> Self {
        Self {
            workspace_dir: workspace_dir.into_os_string().into_string().unwrap(),
            artifact_dir: artifact_dir.into_os_string().into_string().unwrap(),
            pipeline: Pipeline {
                id: Uuid::new_v4().to_string(),
                name: String::new(),
                repository: String::new(),
                workspace_id: Uuid::new_v4().to_string(),
                description: None,
                default_branch: String::new(),
                status: PipelineStatus::Pending,
                steps: Vec::new(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
        }
    }

    /// Loads a pipeline configuration from YAML
    pub fn from_yaml(yaml: &str) -> Result<Self, EngineError> {
        serde_yaml::from_str(yaml).map_err(|e| {
            EngineError::ConfigError(format!("Failed to parse YAML: {}", e))
        })
    }

    /// Converts the config into a Pipeline model
    pub fn to_pipeline(&self) -> Pipeline {
        let steps = self.pipeline.steps.iter().enumerate().map(|(index, step)| {
            // Create a step ID that's unique within the pipeline but can be reused across pipelines
            let step_id = format!("step-{}", index + 1);
            Step {
                id: step_id,
                name: step.name.clone(),
                command: step.command.clone(),
                dependencies: step.dependencies.clone(),
                environment: step.environment.clone(),
                timeout_seconds: step.timeout_seconds,
                status: StepStatus::Pending,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            }
        }).collect();

        Pipeline {
            id: Uuid::new_v4().to_string(),
            name: self.pipeline.name.clone(),
            repository: self.pipeline.repository.clone(),
            workspace_id: self.pipeline.workspace_id.clone(),
            description: self.pipeline.description.clone(),
            default_branch: self.pipeline.default_branch.clone(),
            status: PipelineStatus::Pending,
            steps,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// Validates the pipeline configuration
    pub fn validate(&self) -> Result<(), ValidationError> {
        let steps = &self.pipeline.steps;
        
        // Check for duplicate step names
        for step in steps {
            if steps.iter().filter(|s| s.name == step.name).count() > 1 {
                return Err(ValidationError {
                    message: format!("Duplicate step name: {}", step.name),
                });
            }
        }

        // Check for missing dependencies
        for step in steps {
            for dep in &step.dependencies {
                if !steps.iter().any(|s| s.name == *dep) {
                    return Err(ValidationError {
                        message: format!("Step {} depends on non-existent step {}", step.name, dep),
                    });
                }
            }
        }

        // Check for cyclic dependencies
        for step in steps {
            let mut visited = HashSet::new();
            let mut stack = Vec::new();
            if let Some(cycle) = self.detect_cycles(step, &mut visited, &mut stack) {
                return Err(ValidationError {
                    message: format!("Cyclic dependency detected: {}", cycle.join(" -> ")),
                });
            }
        }

        Ok(())
    }

    fn detect_cycles(&self, step: &Step, visited: &mut HashSet<String>, stack: &mut Vec<String>) -> Option<Vec<String>> {
        if stack.contains(&step.name) {
            let cycle_start = stack.iter().position(|s| s == &step.name).unwrap();
            let mut cycle = stack[cycle_start..].to_vec();
            cycle.push(step.name.clone());
            return Some(cycle);
        }

        if visited.contains(&step.name) {
            return None;
        }

        visited.insert(step.name.clone());
        stack.push(step.name.clone());

        for dep in &step.dependencies {
            if let Some(dep_step) = self.pipeline.steps.iter().find(|s| s.name == *dep) {
                if let Some(cycle) = self.detect_cycles(dep_step, visited, stack) {
                    return Some(cycle);
                }
            }
        }

        stack.pop();
        None
    }
}

pub trait PipelineConfigConversion {
    fn try_into_pipeline(self) -> Result<Pipeline, String>;
}

impl PipelineConfigConversion for PipelineConfig {
    fn try_into_pipeline(self) -> Result<Pipeline, String> {
        Ok(Pipeline {
            id: Uuid::new_v4().to_string(),
            name: self.name,
            repository: self.repository,
            workspace_id: Uuid::new_v4().to_string(),
            description: self.description,
            default_branch: self.default_branch,
            status: PipelineStatus::Pending,
            steps: self.steps.into_iter()
                .map(|s| s.into())
                .collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        })
    }
}

impl From<StepConfig> for Step {
    fn from(config: StepConfig) -> Self {
        Step {
            id: Uuid::new_v4().to_string(),
            name: config.name,
            command: config.command,
            timeout_seconds: config.timeout_seconds,
            environment: config.environment,
            dependencies: config.dependencies,
            status: StepStatus::Pending,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_config() {
        let yaml = r#"
            pipeline:
              name: Test Pipeline
              repository: https://github.com/test/repo
              description: A test pipeline
              default_branch: main
              steps:
                - name: Build
                  command: cargo build
                  timeout_seconds: 300
                - name: Test
                  command: cargo test
                  dependencies: ["Build"]
                  environment:
                    RUST_LOG: debug
        "#;

        let config = Config::from_yaml(yaml).unwrap();
        assert_eq!(config.pipeline.name, "Test Pipeline");
        assert_eq!(config.pipeline.steps.len(), 2);
    }

    #[test]
    fn test_parse_invalid_config() {
        let yaml = r#"
            pipeline:
              invalid: field
        "#;

        let result = Config::from_yaml(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn test_convert_to_pipeline() {
        let yaml = r#"
            pipeline:
              name: Test Pipeline
              repository: https://github.com/test/repo
              steps:
                - name: Build
                  command: cargo build
        "#;

        let config = Config::from_yaml(yaml).unwrap();
        let pipeline = config.to_pipeline();

        assert_eq!(pipeline.name, "Test Pipeline");
        assert_eq!(pipeline.repository, "https://github.com/test/repo");
        assert_eq!(pipeline.steps.len(), 1);
        assert_eq!(pipeline.steps[0].name, "Build");
        assert_eq!(pipeline.steps[0].command, "cargo build");
        assert_eq!(pipeline.steps[0].id, "step-1"); // Verify the new step ID format
    }
}