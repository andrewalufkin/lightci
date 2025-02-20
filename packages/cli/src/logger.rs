// packages/cli/src/logger.rs

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub pipeline_id: Uuid,
    pub step: String,
    pub level: LogLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LogLevel {
    Info,
    Error,
    Debug,
}

pub struct Logger {
    log_dir: PathBuf,
    sender: mpsc::Sender<LogEntry>,
}

impl Logger {
    pub async fn new<P: AsRef<Path>>(log_dir: P) -> Result<Self> {
        std::fs::create_dir_all(&log_dir)?;
        let (sender, mut receiver) = mpsc::channel(100);
        let log_dir = log_dir.as_ref().to_path_buf();
        let log_dir_clone = log_dir.clone();

        tokio::spawn(async move {
            while let Some(entry) = receiver.recv().await {
                if let Err(e) = Self::write_log_entry(&log_dir_clone, &entry).await {
                    eprintln!("Failed to write log entry: {}", e);
                }
            }
        });

        Ok(Self { log_dir, sender })
    }

    pub async fn log(&self, pipeline_id: Uuid, step: &str, level: LogLevel, message: &str) -> Result<()> {
        let entry = LogEntry {
            timestamp: Utc::now(),
            pipeline_id,
            step: step.to_string(),
            level,
            message: message.to_string(),
        };

        self.sender.send(entry).await.map_err(|e| anyhow::anyhow!("Failed to send log entry: {}", e))?;
        Ok(())
    }

    pub async fn get_logs(&self, pipeline_id: &Uuid) -> Result<Vec<LogEntry>> {
        let path = self.log_dir.join(format!("{}.log", pipeline_id));
        if !path.exists() {
            return Ok(Vec::new());
        }

        let content = tokio::fs::read_to_string(&path).await?;
        let entries: Vec<LogEntry> = content
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();

        Ok(entries)
    }

    async fn write_log_entry(log_dir: &Path, entry: &LogEntry) -> Result<()> {
        let path = log_dir.join(format!("{}.log", entry.pipeline_id));
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;

        let line = serde_json::to_string(&entry)? + "\n";
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }
}

pub struct LogStream {
    pipeline_id: Uuid,
    logger: Arc<Logger>,
    last_processed: Option<DateTime<Utc>>,
}

impl LogStream {
    pub fn new(pipeline_id: Uuid, logger: Arc<Logger>) -> Self {
        Self {
            pipeline_id,
            logger,
            last_processed: None,
        }
    }

    pub async fn next(&mut self) -> Result<Option<LogEntry>> {
        let entries = self.logger.get_logs(&self.pipeline_id).await?;
        let new_entries: Vec<_> = entries
            .into_iter()
            .filter(|e| self.last_processed.map_or(true, |t| e.timestamp > t))
            .collect();

        if let Some(entry) = new_entries.first() {
            self.last_processed = Some(entry.timestamp);
            Ok(Some(entry.clone()))
        } else {
            Ok(None)
        }
    }
}