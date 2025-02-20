use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tokio::fs;
use crate::models::{ArtifactError, ArtifactMetadata, RetentionPolicy};
use uuid::Uuid;
use std::sync::Arc;
use tokio::sync::Mutex;
use serde_json;
use chrono::{DateTime, Utc};
use crate::models::EngineError;

#[async_trait]
pub trait ArtifactStorage: Send + Sync {
    async fn store(
        &self,
        source_path: &Path,
        metadata: &ArtifactMetadata,
    ) -> Result<(), ArtifactError>;

    async fn retrieve(
        &self,
        id: &str,
        version: &str,
        destination: &Path,
    ) -> Result<ArtifactMetadata, ArtifactError>;

    async fn check_space(
        &self,
        required_bytes: u64
    ) -> Result<(), ArtifactError>;

    async fn cleanup(&self, policy: &RetentionPolicy) -> Result<(), ArtifactError>;
}

pub struct LocalArtifactStorage {
    root_dir: PathBuf,
    active_artifacts: Arc<Mutex<Vec<ArtifactMetadata>>>,
}

impl LocalArtifactStorage {
    pub async fn new(root_dir: impl AsRef<Path>) -> Result<Self, ArtifactError> {
        let root_path = root_dir.as_ref().to_path_buf();
        println!("Creating LocalArtifactStorage at: {:?}", root_path);
        fs::create_dir_all(&root_path).await.map_err(|e| 
            ArtifactError::StorageError(format!("Failed to create root dir: {}", e))
        )?;

        let metadata_path = root_path.join("metadata.json");
        println!("Checking for metadata at: {:?}", metadata_path);
        let active_artifacts = if fs::metadata(&metadata_path).await.is_ok() {
            println!("Found existing metadata file");
            let content = fs::read_to_string(&metadata_path).await.map_err(|e|
                ArtifactError::StorageError(format!("Failed to read metadata file: {}", e))
            )?;
            let artifacts: Vec<ArtifactMetadata> = serde_json::from_str(&content).map_err(|e|
                ArtifactError::StorageError(format!("Failed to parse metadata: {}", e))
            )?;
            println!("Loaded {} artifacts from metadata", artifacts.len());
            artifacts
        } else {
            println!("No existing metadata file found, starting fresh");
            Vec::new()
        };

        Ok(Self {
            root_dir: root_path,
            active_artifacts: Arc::new(Mutex::new(active_artifacts)),
        })
    }

    fn artifact_path(&self, id: &str, version: &str) -> PathBuf {
        self.root_dir.join(format!("{}_{}", id, version))
    }

    fn metadata_path(&self) -> PathBuf {
        self.root_dir.join("metadata.json")
    }

    async fn save_metadata_with_lock(&self, active: &[ArtifactMetadata]) -> Result<(), ArtifactError> {
        println!("Saving metadata for {} artifacts", active.len());
        let content = serde_json::to_string_pretty(active).map_err(|e|
            ArtifactError::StorageError(format!("Failed to serialize metadata: {}", e))
        )?;
        
        let metadata_path = self.metadata_path();
        println!("Saving metadata to: {:?}", metadata_path);
        if let Some(parent) = metadata_path.parent() {
            println!("Creating parent directory for metadata: {:?}", parent);
            fs::create_dir_all(parent).await.map_err(|e|
                ArtifactError::StorageError(format!("Failed to create parent directory for metadata: {}", e))
            )?;
        }
        
        fs::write(metadata_path, content).await.map_err(|e|
            ArtifactError::StorageError(format!("Failed to write metadata file: {}", e))
        )?;
        println!("Successfully saved metadata");
        Ok(())
    }

    async fn save_metadata(&self) -> Result<(), ArtifactError> {
        let active = self.active_artifacts.lock().await;
        self.save_metadata_with_lock(&active).await
    }

    async fn calculate_available_space(&self) -> Result<u64, ArtifactError> {
        if let Ok(_metadata) = fs::metadata(&self.root_dir).await {
            // TODO: Implement actual available space check for the filesystem
            Ok(1024 * 1024 * 1024) // Dummy 1GB for now
        } else {
            Err(ArtifactError::StorageError("Failed to check available space".into()))
        }
    }
}

#[async_trait]
impl ArtifactStorage for LocalArtifactStorage {
    async fn store(
        &self,
        source_path: &Path,
        metadata: &ArtifactMetadata,
    ) -> Result<(), ArtifactError> {
        println!("Storing artifact at source path: {:?}", source_path);
        
        // Check available space
        println!("Checking available space...");
        self.check_space(metadata.size_bytes).await?;
        println!("Space check passed");

        let artifact_path = self.artifact_path(&metadata.id, &metadata.version);
        println!("Target artifact path: {:?}", artifact_path);
        
        // Ensure parent directories exist
        if let Some(parent) = artifact_path.parent() {
            println!("Creating parent directory: {:?}", parent);
            fs::create_dir_all(parent).await.map_err(|e| 
                ArtifactError::StorageError(format!("Failed to create parent directories: {}", e))
            )?;
            println!("Parent directory created successfully");
        }
        
        // Copy artifact with progress tracking
        println!("Opening source file...");
        let mut source = fs::File::open(source_path).await.map_err(|e| 
            ArtifactError::StorageError(format!("Failed to open source: {}", e))
        )?;
        println!("Source file opened successfully");

        println!("Creating destination file...");
        let mut dest = fs::File::create(&artifact_path).await.map_err(|e|
            ArtifactError::StorageError(format!("Failed to create destination: {}", e))
        )?;
        println!("Destination file created successfully");

        println!("Copying file contents...");
        tokio::io::copy(&mut source, &mut dest).await.map_err(|e|
            ArtifactError::StorageError(format!("Failed to copy artifact: {}", e))
        )?;
        println!("File contents copied successfully");

        // Store metadata
        println!("Acquiring metadata lock...");
        let mut active = self.active_artifacts.lock().await;
        println!("Metadata lock acquired");
        
        println!("Pushing new metadata...");
        active.push(metadata.clone());
        println!("Metadata pushed");
        
        println!("Saving metadata to disk...");
        self.save_metadata_with_lock(&active).await?;
        println!("Successfully stored artifact and metadata");

        Ok(())
    }

    async fn retrieve(
        &self,
        id: &str,
        version: &str,
        destination: &Path,
    ) -> Result<ArtifactMetadata, ArtifactError> {
        let artifact_path = self.artifact_path(id, version);
        println!("Attempting to retrieve artifact from: {:?}", artifact_path);
        
        if !fs::metadata(&artifact_path).await.is_ok() {
            println!("Artifact not found at path: {:?}", artifact_path);
            return Err(ArtifactError::NotFound(format!("{}_{}", id, version)));
        }

        println!("Found artifact, copying to destination: {:?}", destination);
        fs::copy(&artifact_path, destination).await.map_err(|e|
            ArtifactError::StorageError(format!("Failed to retrieve artifact: {}", e))
        )?;

        let active = self.active_artifacts.lock().await;
        let metadata = active.iter()
            .find(|m| m.id == id && m.version == version)
            .cloned()
            .ok_or_else(|| ArtifactError::NotFound(format!("{}_{}", id, version)))?;
        println!("Successfully retrieved artifact metadata");
        
        Ok(metadata)
    }

    async fn check_space(
        &self,
        required_bytes: u64
    ) -> Result<(), ArtifactError> {
        let available = self.calculate_available_space().await?;
        
        if required_bytes > available {
            return Err(ArtifactError::InsufficientSpace {
                needed: required_bytes,
                available,
            });
        }
        
        Ok(())
    }

    async fn cleanup(&self, policy: &RetentionPolicy) -> Result<(), ArtifactError> {
        println!("Starting cleanup with policy: keep_last_n={:?}", policy.keep_last_n);
        let mut active = self.active_artifacts.lock().await;
        println!("Acquired lock with {} active artifacts", active.len());
        
        // Apply retention policy
        if let Some(keep_n) = policy.keep_last_n {
            println!("Applying retention policy to keep last {} artifacts", keep_n);
            let mut to_remove = Vec::new();
            
            // Group by id and sort by creation date
            let mut grouped: std::collections::HashMap<String, Vec<&ArtifactMetadata>> = 
                std::collections::HashMap::new();
            println!("Grouping artifacts by ID");    
            for artifact in active.iter() {
                grouped.entry(artifact.id.clone())
                    .or_default()
                    .push(artifact);
            }
            println!("Grouped into {} distinct IDs", grouped.len());
            
            for (id, artifacts) in grouped.iter_mut() {
                println!("Processing group {}: {} artifacts", id, artifacts.len());
                artifacts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
                
                if artifacts.len() > keep_n {
                    println!("Will remove {} artifacts from group {}", artifacts.len() - keep_n, id);
                    to_remove.extend(artifacts[keep_n..].iter().map(|a| (a.id.clone(), a.version.clone())));
                }
            }
            println!("Total artifacts to remove: {}", to_remove.len());
            
            // Remove artifacts and update metadata
            for (id, version) in to_remove {
                println!("Removing artifact {}_{}", id, version);
                let path = self.artifact_path(&id, &version);
                if let Err(e) = fs::remove_file(path).await {
                    eprintln!("Failed to remove artifact {}_{}: {}", id, version, e);
                }
                active.retain(|m| !(m.id == id && m.version == version));
            }
            
            // Save updated metadata
            println!("Saving updated metadata");
            self.save_metadata_with_lock(&active).await?;
            println!("Cleanup completed successfully");
        }
        
        Ok(())
    }
}

pub struct ArtifactStore {
    root_dir: PathBuf,
}

impl ArtifactStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    pub async fn store_artifact(&self, build_id: &str, name: &str, data: Vec<u8>) -> Result<(), EngineError> {
        let build_dir = self.root_dir.join(build_id);
        fs::create_dir_all(&build_dir)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to create artifact directory: {}", e)))?;

        let artifact_path = build_dir.join(name);
        fs::write(&artifact_path, data)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to write artifact: {}", e)))?;

        Ok(())
    }

    pub async fn get_artifact(&self, build_id: &str, name: &str) -> Result<Vec<u8>, EngineError> {
        let artifact_path = self.root_dir.join(build_id).join(name);
        fs::read(&artifact_path)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to read artifact: {}", e)))
    }

    pub async fn list_artifacts(&self, build_id: &str) -> Result<Vec<String>, EngineError> {
        let build_dir = self.root_dir.join(build_id);
        if !build_dir.exists() {
            return Ok(Vec::new());
        }

        let mut artifacts = Vec::new();
        let mut entries = fs::read_dir(&build_dir)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to read artifact directory: {}", e)))?;

        while let Some(entry) = entries.next_entry()
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to read directory entry: {}", e)))? {
            if let Some(name) = entry.file_name().to_str() {
                artifacts.push(name.to_string());
            }
        }

        Ok(artifacts)
    }

    pub async fn delete_artifact(&self, build_id: &str, name: &str) -> Result<(), EngineError> {
        let artifact_path = self.root_dir.join(build_id).join(name);
        if artifact_path.exists() {
            fs::remove_file(&artifact_path)
                .await
                .map_err(|e| EngineError::WorkspaceError(format!("Failed to delete artifact: {}", e)))?;
        }
        Ok(())
    }

    pub async fn delete_build_artifacts(&self, build_id: &str) -> Result<(), EngineError> {
        let build_dir = self.root_dir.join(build_id);
        if build_dir.exists() {
            fs::remove_dir_all(&build_dir)
                .await
                .map_err(|e| EngineError::WorkspaceError(format!("Failed to delete build artifacts: {}", e)))?;
        }
        Ok(())
    }

    pub async fn get_available_space(&self) -> Result<u64, ArtifactError> {
        if let Ok(_metadata) = fs::metadata(&self.root_dir).await {
            // For now, return a dummy value of 1GB
            Ok(1024 * 1024 * 1024)
        } else {
            Err(ArtifactError::StorageError("Failed to check available space".into()))
        }
    }
}

impl Clone for ArtifactStore {
    fn clone(&self) -> Self {
        Self {
            root_dir: self.root_dir.clone(),
        }
    }
}