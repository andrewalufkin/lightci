// packages/cli/src/tests.rs

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::fs;
    use lightci_core::{PipelineConfig};
    use crate::{CliApp, ExecutionState, LogLevel};

    #[tokio::test]
    async fn test_init_config() {
        let temp_dir = tempdir().unwrap();
        let config_path = temp_dir.path().join("lightci.yml");
        
        let app = CliApp::new().await.unwrap();
        app.init_config(&config_path).await.unwrap();
        
        assert!(config_path.exists());
        let content = fs::read_to_string(&config_path).unwrap();
        let config: PipelineConfig = serde_yaml::from_str(&content).unwrap();
        assert_eq!(config.name, "default");
    }

    #[tokio::test]
    async fn test_run_pipeline() {
        let temp_dir = tempdir().unwrap();
        let config_path = temp_dir.path().join("lightci.yml");
        
        let yaml = r#"
name: test-pipeline
steps:
  echo:
    name: Echo Test
    command: echo "Hello, World!"
"#;
        fs::write(&config_path, yaml).unwrap();
        
        let app = CliApp::new().await.unwrap();
        app.run_pipeline(&config_path, "test-pipeline").await.unwrap();
        
        // Verify pipeline execution
        let all_pipelines = app.tracker.get_all_statuses().await;
        println!("Number of pipelines: {}", all_pipelines.len());
        
        let (pipeline_id, pipeline) = &all_pipelines[0];
        println!("Pipeline ID: {}", pipeline_id);
        println!("Pipeline name: {}", pipeline.name);
        println!("Pipeline state: {:?}", pipeline.state);
        
        assert_eq!(all_pipelines.len(), 1);
        assert_eq!(pipeline.name, "test-pipeline");
        assert!(matches!(pipeline.state, ExecutionState::Success));
    }

    #[tokio::test]
    async fn test_validate_config() {
        let temp_dir = tempdir().unwrap();
        let config_path = temp_dir.path().join("lightci.yml");
        
        // Valid config
        let yaml = r#"
name: test-pipeline
steps:
  step1:
    name: Step 1
    command: echo "test"
"#;
        fs::write(&config_path, yaml).unwrap();
        
        let app = CliApp::new().await.unwrap();
        assert!(app.validate_config(&config_path).await.is_ok());
        
        // Invalid config (circular dependency)
        let yaml = r#"
name: test-pipeline
steps:
  step1:
    name: Step 1
    command: echo "test"
    depends_on: [step2]
  step2:
    name: Step 2
    command: echo "test"
    depends_on: [step1]
"#;
        fs::write(&config_path, yaml).unwrap();
        assert!(app.validate_config(&config_path).await.is_err());
    }

    #[tokio::test]
    async fn test_logging() {
        let temp_dir = tempdir().unwrap();
        let config_path = temp_dir.path().join("lightci.yml");
        
        let yaml = r#"
name: test-pipeline
steps:
  echo:
    name: Echo Test
    command: echo "test logging"
"#;
        fs::write(&config_path, yaml).unwrap();
        
        let app = CliApp::new().await.unwrap();
        app.run_pipeline(&config_path, "test-pipeline").await.unwrap();
        
        // Get pipeline ID from all pipelines instead of just active ones
        let all_pipelines = app.tracker.get_all_statuses().await;
        let (pipeline_id, _) = &all_pipelines[0];
        
        // Verify logs
        let logs = app.logger.get_logs(pipeline_id).await.unwrap();
        assert!(!logs.is_empty());
        
        // Verify log content
        let start_log = logs.iter().find(|l| l.message.contains("Starting pipeline")).unwrap();
        assert!(matches!(start_log.level, LogLevel::Info));
    }
}