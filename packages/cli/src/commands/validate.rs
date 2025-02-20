// cli/src/commands/validate.rs
use std::path::Path;
use anyhow::{Result, Context};

use lightci_core::{
    PipelineConfig,
    ValidationError,
};

pub async fn validate_config(path: &Path) -> Result<()> {
    let yaml = std::fs::read_to_string(path)?;
    let config = PipelineConfig::from_yaml(&yaml)?;
    
    match config.validate() {
        Ok(_) => {
            println!("✓ Configuration is valid");
            println!("\nPipeline: {}", config.name);
            for (step_id, step) in &config.steps {
                println!("  ↳ {}", step_id);
                if !step.depends_on.is_empty() {
                    println!("    depends on: {}", step.depends_on.join(", "));
                }
            }
            Ok(())
        },
        Err(ValidationError::CyclicDependency(cycle)) => {
            anyhow::bail!("Cyclic dependency detected: {}", cycle.join(" → "));
        },
        Err(ValidationError::MissingDependency { step, dependency }) => {
            anyhow::bail!("Step '{}' depends on non-existent step '{}'", step, dependency);
        },
        Err(e) => anyhow::bail!("Validation error: {}", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::collections::HashMap;
    use lightci_core::StepConfig;

    #[tokio::test]
    async fn test_validate_config_with_cycle() {
        let mut steps = HashMap::new();
        steps.insert("a".to_string(), StepConfig {
            name: "a".to_string(),
            retries: None,
            command: "test".to_string(),
            working_dir: None,
            environment: HashMap::new(),
            timeout: None,
            depends_on: vec!["b".to_string()],
        });
        steps.insert("b".to_string(), StepConfig {
            name: "b".to_string(),
            retries: None,
            command: "test".to_string(),
            working_dir: None,
            environment: HashMap::new(),
            timeout: None,
            depends_on: vec!["a".to_string()],
        });

        let config = PipelineConfig {
            name: "test".to_string(),
            version: Some("1.0".to_string()),
            environment: HashMap::new(),
            steps,
        };

        let dir = tempdir().unwrap();
        let config_path = dir.path().join("lightci.yml");
        std::fs::write(&config_path, serde_yaml::to_string(&config).unwrap()).unwrap();

        let result = validate_config(&config_path).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Cyclic dependency"));
    }
}