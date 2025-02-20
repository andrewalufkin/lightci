// cli/src/commands/status.rs
use anyhow::Result;
use colored::*;
use chrono::Utc;
use tabwriter::TabWriter;
use std::io::Write;

use crate::tracker::{ExecutionTracker, ExecutionState};
use super::utils::format_duration;

pub async fn show_status(tracker: &ExecutionTracker) -> Result<()> {
    let statuses = tracker.get_all_statuses().await;
    if statuses.is_empty() {
        println!("No pipeline executions found");
        return Ok(());
    }

    let mut tw = TabWriter::new(vec![]);
    writeln!(&mut tw, "ID\tPIPELINE\tSTATUS\tSTARTED\tDURATION")?;

    for (id, status) in statuses {
        let state_str = match status.state {
            ExecutionState::Running => "🔄 Running".blue(),
            ExecutionState::Success => "✓ Success".green(),
            ExecutionState::Failed => "✗ Failed".red(),
            ExecutionState::Pending => "⏳ Pending".yellow(),
            ExecutionState::Cancelled => "⊘ Cancelled".red(),
        };

        let duration = status.end_time.unwrap_or_else(Utc::now)
            .signed_duration_since(status.start_time)
            .num_seconds();

        writeln!(
            &mut tw,
            "{}\t{}\t{}\t{}\t{}",
            id,
            status.name,
            state_str,
            status.start_time.format("%H:%M:%S"),
            format_duration(duration)
        )?;
    }

    tw.flush()?;
    print!("{}", String::from_utf8(tw.into_inner()?)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use chrono::Duration;

    #[tokio::test]
    async fn test_show_status_empty() {
        let tracker = ExecutionTracker::new();
        show_status(&tracker).await.unwrap();
    }

    #[tokio::test]
    async fn test_show_status_with_pipelines() {
        let tracker = ExecutionTracker::new();
        let id = Uuid::new_v4();
        
        tracker.create_pipeline(
            id,
            "test-pipeline".to_string(),
            vec!["step1".to_string(), "step2".to_string()]
        ).await;

        show_status(&tracker).await.unwrap();
    }
}