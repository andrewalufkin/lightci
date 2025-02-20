pub mod engine;
pub mod models;
pub mod executors;
pub mod grpc;
pub mod db;
pub mod config;
pub mod git;
pub mod workspace;
pub mod artifact;
pub mod traits;
pub mod conversions;

// Include the generated proto file
pub mod proto {
    include!("proto/lightci.rs");
}

// Re-export commonly used types
pub use engine::PipelineEngine;
pub use models::{Pipeline, Step, Build, Artifact, EngineError};
pub use executors::Executor;