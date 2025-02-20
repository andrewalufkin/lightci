use clap::{Parser, Subcommand};
use lightci_core::{
    PipelineEngine,
    PipelineConfig as Config,
    LocalExecutor,
    EngineError,
    Pipeline,
    StepStatus,
};
use std::{path::{Path, PathBuf}, sync::Arc};
use anyhow::Result;
use tokio::time::{sleep, Duration};
use crate::{
    tracker::{ExecutionTracker, ExecutionState, StepStatusUpdate},
    logger::{Logger, LogLevel, LogStream},
};
use chrono::Utc;
use uuid::Uuid;
use dirs;

pub mod commands;
pub mod tracker;
pub mod logger;

#[derive(Parser)]
#[command(name = "lightci")]
#[command(about = "LightCI - Lightweight CI/CD Platform", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Init {
        #[arg(short, long)]
        path: Option<PathBuf>,
    },
    Run {
        pipeline: Option<String>,
        #[arg(short, long)]
        config: Option<PathBuf>,
    },
    Validate {
        #[arg(short, long)]
        config: Option<PathBuf>,
    },
    Status,
    Logs {
        id: String,
        #[arg(short, long)]
        follow: bool,
    },
}

pub struct CliApp {
    engine: PipelineEngine,
    tracker: ExecutionTracker,
    logger: Arc<Logger>,
}

impl CliApp {
    pub async fn new() -> anyhow::Result<Self> {
        let workspace_root = std::env::current_dir()?;
        let executor = Arc::new(LocalExecutor::new(workspace_root));
        let log_dir = dirs::data_local_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not find local data directory"))?
            .join("lightci/logs");
        
        Ok(Self {
            engine: PipelineEngine::new(executor),
            tracker: ExecutionTracker::new(),
            logger: Arc::new(Logger::new(log_dir).await?),
        })
    }

    pub async fn run() -> Result<()> {
        let cli = Cli::parse();
        let app = Self::new().await?;

        match cli.command {
            Commands::Init { path } => {
                app.init_config(&path.unwrap_or_else(|| PathBuf::from("./lightci.yml"))).await?;
            }
            Commands::Run { pipeline, config } => {
                let config_path = config.unwrap_or_else(|| PathBuf::from("./lightci.yml"));
                let pipeline_name = pipeline.unwrap_or_else(|| String::from("default"));
                app.run_pipeline(&config_path, &pipeline_name).await?;
            }
            Commands::Validate { config } => {
                let config_path = config.unwrap_or_else(|| PathBuf::from("./lightci.yml"));
                app.validate_config(&config_path).await?;
            }
            Commands::Status => {
                app.show_status().await?;
            }
            Commands::Logs { id, follow } => {
                let pipeline_id = Uuid::parse_str(&id)?;
                app.stream_logs(&pipeline_id, follow).await?;
            }
        }
        Ok(())
    }

    pub async fn run_pipeline(&self, config_path: &PathBuf, pipeline_name: &str) -> Result<()> {
        let config_str = std::fs::read_to_string(config_path)?;
        let config = Config::from_yaml(&config_str)?;
        let pipeline = config.into_pipeline()?;
        let pipeline_id = pipeline.id;
        
        // Create pipeline in tracker before execution
        self.tracker.create_pipeline(
            pipeline_id,
            pipeline_name.to_string(),
            pipeline.steps.iter().map(|step| step.id.clone()).collect()
        ).await;
        
        // Add this log message for pipeline start
        self.logger.log(
            pipeline_id,
            "pipeline",
            LogLevel::Info,
            &format!("Starting pipeline: {}", pipeline_name)
        ).await?;
        
        // Let the engine handle all the execution logic
        let results = self.engine.execute_pipeline(pipeline).await?;
        println!("Step results: {:?}", results);
        
        // Process the results
        let mut all_successful = true;
        for result in results {
            let state = match result.status {
                StepStatus::Success => ExecutionState::Success,
                StepStatus::Failed => ExecutionState::Failed,
                StepStatus::Skipped => ExecutionState::Failed,
                StepStatus::Running => ExecutionState::Running,
                StepStatus::Pending => ExecutionState::Running,
            };
            println!("Step {} status: {:?} -> state: {:?}", result.step_id, result.status, state);
            
            // Track if any step failed
            if state == ExecutionState::Failed {
                all_successful = false;
            }
            
            // Update tracker with step status
            self.tracker.update_step(
                pipeline_id,
                &result.step_id,
                StepStatusUpdate {
                    state: Some(state.clone()),
                    end_time: Some(Utc::now()),
                    ..Default::default()
                }
            ).await;
            
            let log_level = if state == ExecutionState::Success { LogLevel::Info } else { LogLevel::Error };
            self.logger.log(
                pipeline_id, 
                &result.step_id, 
                log_level, 
                &format!("Step completed with status: {:?}", result.status)
            ).await?;
        }
        
        println!("All successful: {}", all_successful);
        
        // Update the overall pipeline state
        self.tracker.update_pipeline(
            pipeline_id,
            StepStatusUpdate {
                state: Some(if all_successful { ExecutionState::Success } else { ExecutionState::Failed }),
                end_time: Some(Utc::now()),
                ..Default::default()
            }
        ).await;
        
        Ok(())
    }

    async fn stream_logs(&self, pipeline_id: &Uuid, follow: bool) -> Result<()> {
        let mut stream = LogStream::new(*pipeline_id, self.logger.clone());

        loop {
            while let Some(entry) = stream.next().await? {
                println!("[{}] {}: {}", entry.timestamp, entry.step, entry.message);
            }

            if !follow {
                break;
            }

            sleep(Duration::from_secs(1)).await;
        }

        Ok(())
    }

    pub async fn init_config(&self, path: &Path) -> anyhow::Result<()> {
        commands::init_config(path).await
    }

    pub async fn validate_config(&self, path: &Path) -> anyhow::Result<()> {
        commands::validate_config(path).await
    }

    pub async fn show_status(&self) -> anyhow::Result<()> {
        commands::show_status(&self.tracker).await
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = CliApp::new().await?;
    // ... rest of main function
    Ok(())
}

#[cfg(test)]
mod tests;