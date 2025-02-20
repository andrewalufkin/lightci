// packages/cli/src/config.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;
use anyhow::Result;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineConfig {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    pub steps: HashMap<String, StepConfig>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StepConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub retries: Option<u32>,
    #[serde(default)]
    pub working_dir: Option<PathBuf>,
}

impl PipelineConfig {
    pub fn from_yaml(yaml: &str) -> Result<Self> {
        serde_yaml::from_str(yaml).map_err(|e| anyhow::anyhow!("Failed to parse pipeline YAML: {}", e))
    }

    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let contents = std::fs::read_to_string(path)?;
        Self::from_yaml(&contents)
    }

    pub fn validate(&self) -> Result<()> {
        if self.steps.is_empty() {
            return Err(anyhow::anyhow!("Pipeline must contain at least one step"));
        }

        self.validate_dependencies()?;
        self.check_for_cycles()?;
        Ok(())
    }

    fn validate_dependencies(&self) -> Result<()> {
        for (step_id, step) in &self.steps {
            for dep in &step.depends_on {
                if !self.steps.contains_key(dep) {
                    return Err(anyhow::anyhow!(
                        "Step '{}' depends on non-existent step '{}'",
                        step_id, dep
                    ));
                }
            }
        }
        Ok(())
    }

    fn check_for_cycles(&self) -> Result<()> {
        let mut visited = HashMap::new();
        let mut stack = Vec::new();

        for step_id in self.steps.keys() {
            if !visited.contains_key(step_id) {
                self.detect_cycle(step_id, &mut visited, &mut stack)?;
            }
        }
        Ok(())
    }

    fn detect_cycle(
        &self,
        step_id: &str,
        visited: &mut HashMap<String, bool>,
        stack: &mut Vec<String>
    ) -> Result<()> {
        visited.insert(step_id.to_string(), true);
        stack.push(step_id.to_string());

        if let Some(step) = self.steps.get(step_id) {
            for dep in &step.depends_on {
                if !visited.contains_key(dep) {
                    self.detect_cycle(dep, visited, stack)?;
                } else if stack.contains(&dep.to_string()) {
                    return Err(anyhow::anyhow!(
                        "Circular dependency detected: {}",
                        stack.join(" -> ")
                    ));
                }
            }
        }

        stack.pop();
        Ok(())
    }
}

pub fn create_default_config<P: AsRef<Path>>(path: P) -> Result<()> {
    let mut steps = HashMap::new();
    steps.insert("build".to_string(), StepConfig {
        name: "Build Project".to_string(),
        command: "echo 'Building project...'".to_string(),
        environment: HashMap::new(),
        depends_on: vec![],
        timeout: Some(300),
        retries: Some(2),
        working_dir: None,
    });

    let config = PipelineConfig {
        name: "default".to_string(),
        version: Some("1.0".to_string()),
        environment: HashMap::new(),
        steps,
    };

    let yaml = serde_yaml::to_string(&config)?;
    std::fs::write(path, yaml)?;
    Ok(())
}