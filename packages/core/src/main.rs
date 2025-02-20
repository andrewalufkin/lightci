use std::sync::Arc;
use std::path::PathBuf;
use lightci_core::engine::PipelineEngine;
use lightci_core::executors::LocalExecutor;
use lightci_core::grpc::GrpcServer;
use lightci_core::db::Database;
use env_logger;
use log;
use dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables from .env file
    dotenv::dotenv().ok();
    
    // Initialize logging
    env_logger::init();
    
    // Initialize the database connection
    log::info!("Initializing database connection...");
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set in environment");
    let database = match Database::new(&database_url).await {
        Ok(db) => db,
        Err(e) => {
            log::error!("Failed to initialize database: {}", e);
            return Err(e.into());
        }
    };
    let database = Arc::new(database);
    log::info!("Database connection established successfully");
    
    // Set up workspace root path
    let workspace_root = PathBuf::from("./workspace");
    
    // Create the executor
    let executor = Box::new(LocalExecutor::new(workspace_root.clone()));
    
    // Create the pipeline engine with database access
    let engine = PipelineEngine::new(executor, database, workspace_root).await?;
    let engine = Arc::new(engine);
    
    // Create and start the gRPC server
    let grpc_server = GrpcServer::new(engine);
    
    log::info!("Starting gRPC server on 0.0.0.0:50051");
    match grpc_server.serve("0.0.0.0:50051").await {
        Ok(_) => log::info!("gRPC server stopped gracefully"),
        Err(e) => {
            log::error!("gRPC server error: {}", e);
            return Err(e.into());
        }
    }
    
    Ok(())
} 