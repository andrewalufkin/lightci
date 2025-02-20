use crate::models::EngineError;
use crate::git::GitManager;
use crate::git::GitConfig;
use async_trait::async_trait;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use uuid::Uuid;
use crate::traits::WorkspaceManager;
use std::collections::HashMap;
use crypto::sha1::Sha1;
use crypto::digest::Digest;
use crate::models::ArtifactMetadata;
use crate::models::ArtifactError;
use crate::models::RetentionPolicy;
use crate::artifact::ArtifactStorage;
use crate::artifact::LocalArtifactStorage;
use chrono::Utc;
use log::{debug, error};
use git2;

#[derive(Clone)]
pub struct GitCache {
    cache_dir: PathBuf,
    url_to_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
    git_manager: GitManager,
}

impl GitCache {
    pub fn new(root_dir: &Path, git_manager: GitManager) -> Result<Self, EngineError> {
        let cache_dir = root_dir.join("git-cache");
        fs::create_dir_all(&cache_dir)?;
        
        Ok(Self {
            cache_dir,
            url_to_cache: Arc::new(Mutex::new(HashMap::new())),
            git_manager,
        })
    }

    fn cache_path(&self, url: &str) -> PathBuf {
        let mut hasher = Sha1::new();
        hasher.input_str(url);
        self.cache_dir.join(hasher.result_str())
    }

    pub async fn get_or_create_bare(&self, url: &str) -> Result<PathBuf, EngineError> {
        let mut cache_map = self.url_to_cache.lock().await;
        
        if let Some(path) = cache_map.get(url) {
            return Ok(path.clone());
        }

        let cache_path = self.cache_path(url);
        if !cache_path.exists() {
            self.git_manager.clone_bare(url, &cache_path)
                .await
                .map_err(|e| EngineError::GitError(e.to_string()))?;
            cache_map.insert(url.to_string(), cache_path.clone());
        }

        Ok(cache_path)
    }

    pub async fn update_cache(&self, url: &str) -> Result<(), EngineError> {
        let cache_path = self.get_or_create_bare(url).await?;
        self.git_manager.fetch_all(&cache_path)
            .await
            .map_err(|e| EngineError::GitError(e.to_string()))?;
        Ok(())
    }

    pub async fn cleanup_old_caches(&self, max_age: std::time::Duration) -> Result<(), EngineError> {
        let now = std::time::SystemTime::now();
        let cache_map = self.url_to_cache.lock().await;
        
        for path in cache_map.values() {
            if let Ok(metadata) = fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    if now.duration_since(modified)? > max_age {
                        fs::remove_dir_all(path)?;
                    }
                }
            }
        }
        Ok(())
    }
}

pub struct FileSystemWorkspaceManager {
    root_path: PathBuf,
}

impl FileSystemWorkspaceManager {
    pub async fn new(root_path: PathBuf) -> Result<Self, EngineError> {
        tokio::fs::create_dir_all(&root_path)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to create workspace directory: {}", e)))?;

        Ok(Self { root_path })
    }

    pub async fn create_workspace(&self, id: &str) -> Result<PathBuf, EngineError> {
        let workspace_path = self.root_path.join(id);
        tokio::fs::create_dir_all(&workspace_path)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to create workspace: {}", e)))?;

        Ok(workspace_path)
    }

    pub async fn delete_workspace(&self, id: &str) -> Result<(), EngineError> {
        let workspace_path = self.root_path.join(id);
        if workspace_path.exists() {
            tokio::fs::remove_dir_all(&workspace_path)
                .await
                .map_err(|e| EngineError::WorkspaceError(format!("Failed to delete workspace: {}", e)))?;
        }
        Ok(())
    }

    pub async fn get_workspace_path(&self, id: &str) -> PathBuf {
        self.root_path.join(id)
    }

    pub async fn clone_repository(
        &self,
        workspace_id: &str,
        repository_url: &str,
        branch: Option<&str>
    ) -> Result<PathBuf, EngineError> {
        let workspace_path = self.get_workspace_path(workspace_id).await;
        let repo_path = workspace_path.join("repo");

        // Create workspace directory if it doesn't exist
        tokio::fs::create_dir_all(&workspace_path)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to create workspace directory: {}", e)))?;

        // Clone the repository
        let git_manager = GitManager::new(GitConfig {
            timeout: Duration::from_secs(300),
            ssh_key_path: None,
            username: Some("git".to_string()),
            password: None,
        });

        git_manager.clone_repository(repository_url, &repo_path, branch)
            .await
            .map_err(|e| EngineError::GitError(e.to_string()))?;

        Ok(repo_path)
    }

    // Helper method to get pipeline-specific artifact storage
    async fn get_artifact_storage(&self, pipeline_id: Uuid) -> Result<Box<dyn ArtifactStorage>, EngineError> {
        let pipeline_artifacts_dir = self.root_path.join("artifacts").join(pipeline_id.to_string());
        Ok(Box::new(LocalArtifactStorage::new(pipeline_artifacts_dir).await?))
    }

    pub async fn store_artifact(
        &self,
        pipeline_id: Uuid,
        step_id: &str,
        source_path: &Path,
        version: &str,
    ) -> Result<ArtifactMetadata, EngineError> {
        // Validate workspace exists
        let workspace_path = self.root_path.join(pipeline_id.to_string());
        if !workspace_path.exists() {
            return Err(EngineError::WorkspaceError(
                format!("Workspace does not exist for pipeline {}", pipeline_id)
            ));
        }

        let absolute_source_path = workspace_path.join(source_path);
        if !absolute_source_path.exists() {
            return Err(EngineError::WorkspaceError(
                format!("Source file does not exist: {}", source_path.display())
            ));
        }

        if !absolute_source_path.starts_with(&workspace_path) {
            return Err(EngineError::WorkspaceError(
                "Source path must be within workspace".into()
            ));
        }

        // Create metadata for the artifact
        let metadata = ArtifactMetadata {
            id: format!("{}-{}", pipeline_id, step_id),
            version: version.to_string(),
            build_id: Uuid::new_v4(), // Generate a new build ID
            pipeline_id,
            step_id: step_id.to_string(),
            created_at: chrono::Utc::now(),
            size_bytes: tokio::fs::metadata(&absolute_source_path).await?.len(),
            content_hash: "".to_string(), // TODO: Calculate content hash if needed
            retention_policy: RetentionPolicy {
                keep_last_n: Some(5),
                keep_successful: false,
                min_age_days: None,
                patterns_to_keep: Vec::new(),
            },
        };

        // Get pipeline-specific storage
        let artifact_storage = self.get_artifact_storage(pipeline_id).await?;
        
        // Store the artifact with its metadata
        artifact_storage.store(&absolute_source_path, &metadata).await?;
        Ok(metadata)  // Return the metadata after successful storage
    }

    pub async fn retrieve_artifact(
        &self,
        pipeline_id: Uuid,
        artifact_id: &str,
        version: &str,
    ) -> Result<PathBuf, EngineError> {
        let workspace_path = self.root_path.join(pipeline_id.to_string());
        if !workspace_path.exists() {
            return Err(EngineError::WorkspaceError(
                format!("Workspace does not exist for pipeline {}", pipeline_id)
            ));
        }

        let artifacts_dir = workspace_path.join("artifacts");
        tokio::fs::create_dir_all(&artifacts_dir).await?;

        let destination = artifacts_dir.join(format!("{}_{}", artifact_id, version));

        // Get pipeline-specific storage
        let artifact_storage = self.get_artifact_storage(pipeline_id).await?;
        
        // Retrieve the artifact
        artifact_storage.retrieve(artifact_id, version, &destination).await?;

        Ok(PathBuf::from("artifacts").join(format!("{}_{}", artifact_id, version)))
    }

    pub async fn cleanup_artifacts(
        &self,
        pipeline_id: Uuid,
        policy: &RetentionPolicy
    ) -> Result<(), EngineError> {
        // Get pipeline-specific storage
        let artifact_storage = self.get_artifact_storage(pipeline_id).await?;
        
        // Clean up artifacts
        artifact_storage.cleanup(policy).await?;

        // Clean up the workspace artifacts directory
        let workspace_path = self.root_path.join(pipeline_id.to_string());
        let artifacts_dir = workspace_path.join("artifacts");
        if artifacts_dir.exists() {
            tokio::fs::remove_dir_all(&artifacts_dir).await?;
        }

        Ok(())
    }
}

#[async_trait]
impl WorkspaceManager for FileSystemWorkspaceManager {
    async fn create(&self, pipeline_id: Uuid) -> Result<PathBuf, EngineError> {
        let workspace_path = self.root_path.join(pipeline_id.to_string());
        debug!("Creating workspace directory at {:?}", workspace_path);
        
        if tokio::fs::metadata(&workspace_path).await.is_ok() {
            tokio::fs::remove_dir_all(&workspace_path)
                .await
                .map_err(|e| EngineError::WorkspaceError(format!("Failed to clean existing workspace: {}", e)))?;
        }

        tokio::fs::create_dir_all(&workspace_path)
            .await
            .map_err(|e| EngineError::WorkspaceError(format!("Failed to create workspace directory: {}", e)))?;

        Ok(workspace_path)
    }

    async fn cleanup(&self, pipeline_id: Uuid) -> Result<(), EngineError> {
        let workspace_path = self.root_path.join(pipeline_id.to_string());
        debug!("Cleaning up workspace at {:?}", workspace_path);
        
        if tokio::fs::metadata(&workspace_path).await.is_ok() {
            tokio::fs::remove_dir_all(&workspace_path)
                .await
                .map_err(|e| EngineError::WorkspaceError(format!("Failed to cleanup workspace: {}", e)))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use std::fs::File;
    use std::io::Write;

    #[tokio::test]
    async fn test_workspace_lifecycle() {
        let temp_dir = tempdir().unwrap();
        let manager = FileSystemWorkspaceManager::new(temp_dir.path().to_path_buf()).unwrap();
        let build_id = Uuid::new_v4();

        // Test workspace creation
        let workspace_path = manager.create(build_id).await.unwrap();
        assert!(workspace_path.exists());
        assert!(workspace_path.is_dir());

        // Test workspace cleanup
        manager.cleanup(build_id).await.unwrap();
        assert!(!workspace_path.exists());
    }

    #[tokio::test]
    async fn test_artifact_lifecycle() -> Result<(), EngineError> {
        // Setup
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let manager = FileSystemWorkspaceManager::new(temp_dir.path().to_path_buf())?;
        let pipeline_id = Uuid::new_v4();
        let workspace_path = manager.create(pipeline_id).await?;

        // Create a test file in the workspace
        let test_file_path = PathBuf::from("test_artifact.txt");
        let test_file_abs_path = workspace_path.join(&test_file_path);
        let mut file = File::create(&test_file_abs_path).expect("Failed to create test file");
        file.write_all(b"test content").expect("Failed to write test content");

        // Test storing artifact
        let metadata = manager.store_artifact(
            pipeline_id,
            "test-step",
            &test_file_path,
            "1.0.0"
        ).await?;
        assert_eq!(metadata.version, "1.0.0");

        // Test retrieving artifact
        let retrieved_path = manager.retrieve_artifact(
            pipeline_id,
            &format!("{}-test-step", pipeline_id),
            "1.0.0"
        ).await?;
        assert!(workspace_path.join(&retrieved_path).exists());

        // Test cleanup with retention policy
        manager.cleanup_artifacts(
            pipeline_id,
            &RetentionPolicy {
                keep_last_n: None,
                keep_successful: false,
                min_age_days: None,
                patterns_to_keep: Vec::new(),
            }
        ).await?;

        // Verify artifact is removed
        assert!(!workspace_path.join(&retrieved_path).exists());

        // Cleanup
        manager.cleanup(pipeline_id).await?;
        
        Ok(())
    }

    #[tokio::test]
    async fn test_artifact_error_cases() -> Result<(), EngineError> {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let manager = FileSystemWorkspaceManager::new(temp_dir.path().to_path_buf())?;
        let pipeline_id = Uuid::new_v4();

        // Test storing artifact in non-existent workspace
        let result = manager.store_artifact(
            pipeline_id,
            "test-step",
            Path::new("nonexistent.txt"),
            "1.0.0"
        ).await;
        assert!(matches!(result, Err(EngineError::WorkspaceError(_))));

        // Create workspace for remaining tests
        let workspace_path = manager.create(pipeline_id).await?;

        // Test storing non-existent file
        let result = manager.store_artifact(
            pipeline_id,
            "test-step",
            Path::new("nonexistent.txt"),
            "1.0.0"
        ).await;
        assert!(matches!(result, Err(EngineError::WorkspaceError(_))));

        // Test retrieving non-existent artifact
        let result = manager.retrieve_artifact(
            pipeline_id,
            "nonexistent",
            "1.0.0"
        ).await;
        assert!(matches!(result, Err(EngineError::ArtifactError(_))));

        // Test path traversal attempt
        let result = manager.store_artifact(
            pipeline_id,
            "test-step",
            Path::new("../outside.txt"),
            "1.0.0"
        ).await;
        assert!(matches!(result, Err(EngineError::WorkspaceError(_))));

        // Cleanup
        manager.cleanup(pipeline_id).await?;
        
        Ok(())
    }

    #[tokio::test]
    async fn test_multiple_artifact_versions() -> Result<(), EngineError> {
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let manager = FileSystemWorkspaceManager::new(temp_dir.path().to_path_buf())?;
        let pipeline_id = Uuid::new_v4();
        let workspace_path = manager.create(pipeline_id).await?;

        // Create test file
        let test_file_path = PathBuf::from("test_artifact.txt");
        let test_file_abs_path = workspace_path.join(&test_file_path);
        let mut file = File::create(&test_file_abs_path).expect("Failed to create test file");
        file.write_all(b"test content").expect("Failed to write test content");

        // Store multiple versions
        for version in &["1.0.0", "1.0.1", "1.0.2"] {
            manager.store_artifact(
                pipeline_id,
                "test-step",
                &test_file_path,
                version
            ).await?;
        }

        // Test retention policy keeping last 2 versions
        manager.cleanup_artifacts(
            pipeline_id,
            &RetentionPolicy {
                keep_last_n: Some(2),
                keep_successful: false,
                min_age_days: None,
                patterns_to_keep: Vec::new(),
            }
        ).await?;

        // Verify old version is removed but newer ones exist
        let artifact_id = format!("{}-test-step", pipeline_id);
        let result = manager.retrieve_artifact(
            pipeline_id,
            &artifact_id,
            "1.0.0"
        ).await;
        assert!(matches!(result, Err(EngineError::ArtifactError(_))));

        // Verify newer versions still exist
        for version in &["1.0.1", "1.0.2"] {
            let path = manager.retrieve_artifact(
                pipeline_id,
                &artifact_id,
                version
            ).await?;
            assert!(workspace_path.join(&path).exists());
        }

        // Cleanup
        manager.cleanup(pipeline_id).await?;
        
        Ok(())
    }
}