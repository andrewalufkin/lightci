// cli/src/commands.rs
mod utils {
    pub(crate) fn format_duration(seconds: i64) -> String {
        if seconds < 60 {
            format!("{}s", seconds)
        } else if seconds < 3600 {
            format!("{}m {}s", seconds / 60, seconds % 60)
        } else {
            format!("{}h {}m {}s", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        }
    }
}

pub mod init;
pub mod validate;
pub mod status;

pub use init::init_config;
pub use validate::validate_config;
pub use status::show_status;