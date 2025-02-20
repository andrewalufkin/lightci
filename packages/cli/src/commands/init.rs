// cli/src/commands/init.rs
use std::path::Path;
use anyhow::{Result, Context};
use serde_yaml;
use uuid::Uuid;
use std::collections::HashMap;
use lightci_core::{
    PipelineConfig,
    Pipeline,
    Step,
    StepConfig,
};

pub async fn init_config(path: &Path) -> Result<()> {
    if path.exists() {
        anyhow::bail!("Configuration file already exists at {}", path.display());
    }

    let example_config = PipelineConfig {
        name: "default".to_string(),
        version: Some("1.0".to_string()),
        environment: HashMap::new(),
        steps: {
            let mut steps = HashMap::new();
            steps.insert(
                "build".to_string(), 
                StepConfig {
                    name: "Build Project".to_string(),
                    command: "echo 'Building project...'".to_string(),
                    environment: HashMap::new(),
                    depends_on: vec![],
                    timeout: Some(300),
                    retries: Some(2),
                    working_dir: None,
                }
            );
            steps.insert(
                "test".to_string(),
                StepConfig {
                    name: "Run Tests".to_string(),
                    command: "echo 'Running tests...'".to_string(),
                    environment: HashMap::new(),
                    depends_on: vec!["build".to_string()],
                    timeout: Some(300),
                    retries: Some(1),
                    working_dir: None,
                }
            );
            steps
        },
    };

    let yaml = serde_yaml::to_string(&example_config)?;
    std::fs::write(path, yaml).context("Failed to write config file")?;
    
    println!("Created new configuration at {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_init_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("lightci.yml");
        
        init_config(&config_path).await.unwrap();
        assert!(config_path.exists());
    }
}