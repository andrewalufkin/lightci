use git2::{Repository, FetchOptions, RemoteCallbacks, Cred};
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::sync::Mutex;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use std::fmt;
use std::time::SystemTimeError;
use std::io;
use std::collections::HashSet;
use tokio::process::Command;
use crate::models::EngineError;
use log::{debug, error};

#[derive(Debug)]
pub enum GitError {
    Git(git2::Error),
    InvalidPath(String),
    Auth(String),
    Timeout(String),
    Join(String),
}

impl From<tokio::task::JoinError> for GitError {
    fn from(err: tokio::task::JoinError) -> Self {
        GitError::Join(err.to_string())
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::Git(err) => write!(f, "Git error: {}", err),
            GitError::InvalidPath(msg) => write!(f, "Invalid path error: {}", msg),
            GitError::Auth(msg) => write!(f, "Authentication error: {}", msg),
            GitError::Timeout(msg) => write!(f, "Timeout error: {}", msg),
            GitError::Join(msg) => write!(f, "Join error: {}", msg),
        }
    }
}

impl From<git2::Error> for GitError {
    fn from(err: git2::Error) -> Self {
        match err.code() {
            git2::ErrorCode::Auth => GitError::Auth(err.message().to_string()),
            _ => GitError::Git(err)
        }
    }
}

impl From<SystemTimeError> for GitError {
    fn from(err: SystemTimeError) -> Self {
        GitError::Git(git2::Error::from_str(&err.to_string()))
    }
}

impl From<io::Error> for GitError {
    fn from(err: io::Error) -> Self {
        GitError::Git(git2::Error::from_str(&err.to_string()))
    }
}

#[derive(Clone)]
pub struct GitConfig {
    pub timeout: Duration,
    pub ssh_key_path: Option<PathBuf>,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(300),
            ssh_key_path: None,
            username: Some("git".to_string()),
            password: None,
        }
    }
}

#[derive(Clone)]
pub struct GitManager {
    config: GitConfig,
    active_operations: Arc<Mutex<HashSet<String>>>,
}

impl GitManager {
    pub fn new(config: GitConfig) -> Self {
        Self {
            config,
            active_operations: Arc::new(Mutex::new(HashSet::new()))
        }
    }

    pub fn new_default() -> Self {
        Self::new(GitConfig::default())
    }

    fn create_callbacks(&self) -> RemoteCallbacks {
        let config = self.config.clone();
        let mut callbacks = RemoteCallbacks::new();
        callbacks.credentials(move |_url, username_from_url, _allowed_types| {
            if let Some(ref ssh_key) = config.ssh_key_path {
                Cred::ssh_key(
                    username_from_url.unwrap_or("git"),
                    None,
                    Path::new(ssh_key),
                    None,
                )
            } else if let (Some(ref username), Some(ref password)) = 
                (&config.username, &config.password) {
                Cred::userpass_plaintext(username, password)
            } else {
                Cred::default()
            }
        });
        callbacks
    }

    pub async fn clone_repository(
        &self,
        url: &str,
        target_path: &Path,
        branch: Option<&str>
    ) -> Result<(), EngineError> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("clone")
           .arg("--quiet")
           .arg(url)
           .arg(target_path);

        if let Some(branch) = branch {
            cmd.arg("--branch").arg(branch);
        }

        let output = cmd.output().await
            .map_err(|e| EngineError::GitError(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EngineError::GitError(format!("Git clone failed: {}", stderr)));
        }

        Ok(())
    }

    pub async fn fetch_repository(
        &self,
        repo_path: &Path,
        remote: &str,
        branch: Option<&str>
    ) -> Result<(), EngineError> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(repo_path)
           .arg("fetch")
           .arg("--quiet")
           .arg(remote);

        if let Some(branch) = branch {
            cmd.arg(branch);
        }

        let output = cmd.output().await
            .map_err(|e| EngineError::GitError(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EngineError::GitError(format!("Git fetch failed: {}", stderr)));
        }

        Ok(())
    }

    pub async fn checkout_commit(
        &self,
        repo_path: &Path,
        commit: &str
    ) -> Result<(), EngineError> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(repo_path)
           .arg("checkout")
           .arg("--quiet")
           .arg(commit);

        let output = cmd.output().await
            .map_err(|e| EngineError::GitError(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(EngineError::GitError(format!("Git checkout failed: {}", stderr)));
        }

        Ok(())
    }

    pub async fn checkout_branch(
        &self,
        repository_path: &Path,
        reference: &str,
    ) -> Result<(), EngineError> {
        debug!("Checking out {} in repository at {:?}", reference, repository_path);

        let output = Command::new("git")
            .current_dir(repository_path)
            .arg("checkout")
            .arg(reference)
            .output()
            .await
            .map_err(|e| EngineError::GitError(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Git checkout failed: {}", stderr);
            return Err(EngineError::GitError(format!("Git checkout failed: {}", stderr)));
        }

        debug!("Successfully checked out {}", reference);
        Ok(())
    }

    fn get_init_options(&self) -> git2::RepositoryInitOptions {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.bare(false);
        opts
    }

    async fn track_operation(&self, key: &str) -> Result<(), GitError> {
        let mut ops = self.active_operations.lock().await;
        if ops.contains(key) {
            return Err(GitError::Timeout(
                "Operation already in progress".to_string()
            ));
        }
        ops.insert(key.to_string());
        Ok(())
    }

    async fn complete_operation(&self, key: &str) {
        let mut ops = self.active_operations.lock().await;
        ops.remove(key);
    }

    pub async fn clone_bare(
        &self,
        url: &str,
        target_path: &Path,
    ) -> Result<Repository, GitError> {
        let timeout = self.config.timeout;
        
        tokio::time::timeout(
            timeout,
            self.clone_bare_inner(url, target_path)
        )
        .await
        .map_err(|_| GitError::Timeout(format!("Operation timed out after {} seconds", timeout.as_secs())))?
    }

    pub async fn clone_bare_inner(
        &self,
        url: &str,
        target_path: &Path,
    ) -> Result<Repository, GitError> {
        let url = url.to_string();
        let target_path = target_path.to_path_buf();
        let auth_config = self.config.clone();

        let repo_key = format!("{}:{}", url, target_path.display());
        self.track_operation(&repo_key).await?;

        let result = tokio::task::spawn_blocking(move || {
            let mut callbacks = RemoteCallbacks::new();
            callbacks.credentials(move |_url, username_from_url, _allowed_types| {
                if let Some(ref ssh_key) = auth_config.ssh_key_path {
                    Cred::ssh_key(
                        username_from_url.unwrap_or("git"),
                        None,
                        Path::new(ssh_key),
                        None,
                    )
                } else if let (Some(ref username), Some(ref password)) = 
                    (&auth_config.username, &auth_config.password) {
                    Cred::userpass_plaintext(username, password)
                } else {
                    Cred::default()
                }
            });

            let mut fetch_options = FetchOptions::new();
            fetch_options.remote_callbacks(callbacks);

            // Set up bare repository init options
            let mut opts = git2::RepositoryInitOptions::new();
            opts.bare(true);
            opts.external_template(false);
            opts.mkdir(true);

            // Initialize bare repository
            let repo = Repository::init_opts(&target_path, &opts)
                .map_err(|e| match e.code() {
                    git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                    _ => GitError::Git(e)
                })?;

            // Configure remote in a separate scope
            {
                // Configure remote
                repo.remote("origin", &url)
                    .map_err(GitError::Git)?;

                // Fetch everything with --mirror
                let mut remote = repo.find_remote("origin")
                    .map_err(GitError::Git)?;

                remote.fetch(
                    &["+refs/*:refs/*"],  // Mirror all refs
                    Some(&mut fetch_options),
                    Some("Fetching mirror")
                )
                .map_err(|e| match e.code() {
                    git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                    _ => GitError::Git(e)
                })?;
            } // Remote is dropped here

            // Configure core.bare
            {
                let mut config = repo.config()
                    .map_err(GitError::Git)?;
                config.set_bool("core.bare", true)
                    .map_err(GitError::Git)?;
            } // Config is dropped here

            Ok::<Repository, GitError>(repo)
        })
        .await
        .map_err(|e| GitError::Join(e.to_string()))??;

        self.complete_operation(&repo_key).await;
        Ok(result)
    }

    pub async fn fetch_all(&self, repo_path: &Path) -> Result<(), GitError> {
        let repo_path = repo_path.to_path_buf();
        let timeout = self.config.timeout;
        let auth_config = self.config.clone();
        
        tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || {
                let mut fetch_options = FetchOptions::new();
                let mut callbacks = RemoteCallbacks::new();
                callbacks.credentials(move |_url, username_from_url, _allowed_types| {
                    if let Some(ref ssh_key) = auth_config.ssh_key_path {
                        Cred::ssh_key(
                            username_from_url.unwrap_or("git"),
                            None,
                            Path::new(ssh_key),
                            None,
                        )
                    } else if let (Some(ref username), Some(ref password)) = 
                        (&auth_config.username, &auth_config.password) {
                        Cred::userpass_plaintext(username, password)
                    } else {
                        Cred::default()
                    }
                });
                fetch_options.remote_callbacks(callbacks);
                fetch_options.prune(git2::FetchPrune::On);
                fetch_options.download_tags(git2::AutotagOption::All);
                
                let repo = Repository::open(repo_path)
                    .map_err(|e| match e.code() {
                        git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                        _ => GitError::Git(e)
                    })?;

                // Fetch from all remotes
                for remote in repo.remotes()?.iter() {
                    let remote_name = remote.ok_or_else(|| 
                        GitError::Git(git2::Error::from_str("Invalid remote name"))
                    )?;
                    
                    repo.find_remote(remote_name)
                        .map_err(GitError::Git)?
                        .fetch(
                            &[] as &[&str],
                            Some(&mut fetch_options),
                            Some("Fetching all refs")
                        )
                        .map_err(|e| match e.code() {
                            git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                            _ => GitError::Git(e)
                        })?;
                }
                
                Ok::<(), GitError>(())
            })
        )
        .await
        .map_err(|_| GitError::Timeout(format!("Operation timed out after {} seconds", timeout.as_secs())))??;

        Ok(())
    }

    pub async fn clone_from_bare(
        &self,
        bare_repo: &Path,
        target_path: &Path,
        reference: Option<&str>,
        depth: Option<u32>,
    ) -> Result<(), GitError> {
        let bare_repo = bare_repo.to_path_buf();
        let target_path = target_path.to_path_buf();
        let reference = reference.map(|s| s.to_string());
        let timeout = self.config.timeout;
        let auth_config = self.config.clone();

        tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || {
                let mut callbacks = RemoteCallbacks::new();
                callbacks.credentials(move |_url, username_from_url, _allowed_types| {
                    if let Some(ref ssh_key) = auth_config.ssh_key_path {
                        Cred::ssh_key(
                            username_from_url.unwrap_or("git"),
                            None,
                            Path::new(ssh_key),
                            None,
                        )
                    } else if let (Some(ref username), Some(ref password)) = 
                        (&auth_config.username, &auth_config.password) {
                        Cred::userpass_plaintext(username, password)
                    } else {
                        Cred::default()
                    }
                });

                let mut fetch_options = FetchOptions::new();
                fetch_options.remote_callbacks(callbacks);
                if let Some(depth) = depth {
                    fetch_options.depth(depth.try_into().map_err(|_| 
                        GitError::Git(git2::Error::from_str("Invalid depth value"))
                    )?);
                }

                let mut builder = git2::build::RepoBuilder::new();
                builder.fetch_options(fetch_options);
                builder.clone_local(git2::build::CloneLocal::Local);

                // Clone using the bare repo as both source and reference
                let repo = builder.clone(
                    bare_repo.to_str().ok_or_else(|| 
                        GitError::InvalidPath("Invalid bare repo path".to_string())
                    )?,
                    &target_path
                ).map_err(|e| match e.code() {
                    git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                    _ => GitError::Git(e)
                })?;

                // If a specific reference was requested, check it out
                if let Some(ref_name) = reference {
                    let obj = repo.revparse_single(&ref_name)
                        .map_err(GitError::Git)?;

                    repo.checkout_tree(&obj, None)
                        .map_err(GitError::Git)?;

                    // If it's a branch, set HEAD to it
                    if ref_name.starts_with("refs/heads/") || !ref_name.contains('/') {
                        let branch_name = if ref_name.contains('/') {
                            ref_name.split('/').last().unwrap_or(&ref_name)
                        } else {
                            &ref_name
                        };
                        repo.set_head(&format!("refs/heads/{}", branch_name))
                            .map_err(GitError::Git)?;
                    } else {
                        // Otherwise set HEAD to detached at the specified reference
                        repo.set_head_detached(obj.id())
                            .map_err(GitError::Git)?;
                    }
                }

                Ok::<(), GitError>(())
            })
        )
        .await
        .map_err(|_| GitError::Timeout(format!("Operation timed out after {} seconds", timeout.as_secs())))??;

        Ok(())
    }

    pub async fn fetch_and_checkout(
        &self,
        repo_path: &Path,
        reference: Option<&str>,
    ) -> Result<(), GitError> {
        let repo_path = repo_path.to_path_buf();
        let reference = reference.map(|s| s.to_string());
        let timeout = self.config.timeout;
        let auth_config = self.config.clone();

        tokio::time::timeout(
            timeout,
            tokio::task::spawn_blocking(move || {
                // Open the repository
                let repo = Repository::open(&repo_path)
                    .map_err(|e| match e.code() {
                        git2::ErrorCode::Auth => GitError::Auth(e.message().to_string()),
                        _ => GitError::Git(e)
                    })?;

                // Set up fetch options with authentication
                let mut callbacks = RemoteCallbacks::new();
                callbacks.credentials(move |_url, username_from_url, _allowed_types| {
                    if let Some(ref ssh_key) = auth_config.ssh_key_path {
                        Cred::ssh_key(
                            username_from_url.unwrap_or("git"),
                            None,
                            Path::new(ssh_key),
                            None,
                        )
                    } else if let (Some(ref username), Some(ref password)) = 
                        (&auth_config.username, &auth_config.password) {
                        Cred::userpass_plaintext(username, password)
                    } else {
                        Cred::default()
                    }
                });

                let mut fetch_options = FetchOptions::new();
                fetch_options.remote_callbacks(callbacks);
                fetch_options.download_tags(git2::AutotagOption::All);
                fetch_options.update_fetchhead(true);

                // Fetch from all remotes
                for remote_name in repo.remotes()?.iter().flatten() {
                    let mut remote = repo.find_remote(remote_name)?;
                    remote.fetch(
                        &[] as &[&str],
                        Some(&mut fetch_options),
                        None
                    )?;
                }

                // If a reference is specified, check it out
                if let Some(ref_name) = reference {
                    let obj = repo.revparse_single(&ref_name)?;

                    // Create a checkout builder with safe defaults
                    let mut checkout_builder = git2::build::CheckoutBuilder::new();
                    checkout_builder
                        .force() // Force checkout to overwrite local changes
                        .remove_untracked(true) // Remove untracked files
                        .remove_ignored(true) // Remove ignored files
                        .use_theirs(true); // Use remote version on conflict

                    // Perform the checkout
                    repo.checkout_tree(&obj, Some(&mut checkout_builder))?;

                    // Update HEAD
                    if ref_name.starts_with("refs/heads/") || !ref_name.contains('/') {
                        // If it's a branch reference or simple branch name
                        let branch_name = if ref_name.contains('/') {
                            ref_name.split('/').last().unwrap_or(&ref_name)
                        } else {
                            &ref_name
                        };
                        repo.set_head(&format!("refs/heads/{}", branch_name))?;
                    } else {
                        // Otherwise set HEAD to detached at the specified reference
                        repo.set_head_detached(obj.id())?;
                    }
                } else {
                    // If no reference specified, update the current branch
                    let head = repo.head()?;
                    if head.is_branch() {
                        let branch_name = head.shorthand().unwrap_or("HEAD");
                        let obj = repo.revparse_single(&format!("refs/remotes/origin/{}", branch_name))?;
                        
                        let mut checkout_builder = git2::build::CheckoutBuilder::new();
                        checkout_builder
                            .force()
                            .remove_untracked(true)
                            .remove_ignored(true)
                            .use_theirs(true);

                        repo.checkout_tree(&obj, Some(&mut checkout_builder))?;
                        repo.set_head(&format!("refs/heads/{}", branch_name))?;
                    }
                }

                Ok::<(), GitError>(())
            })
        )
        .await
        .map_err(|_| GitError::Timeout(format!("Operation timed out after {} seconds", timeout.as_secs())))??;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    
    #[tokio::test]
    async fn test_auth_failure() {
        let config = GitConfig {
            ssh_key_path: Some("invalid/path".to_string()),
            username: None,
            password: None,
            timeout: Duration::from_secs(30),
        };
        
        let git_manager = GitManager::new(config);
        let temp_dir = TempDir::new().unwrap();
        
        let result = git_manager
            .clone_repository(
                "https://github.com/private/repo.git",
                temp_dir.path(),
                None
            )
            .await;
            
        assert!(matches!(result, Err(GitError::Auth(_))));
    }

    #[tokio::test]
    async fn test_timeout() {
        let config = GitConfig {
            ssh_key_path: None,
            username: None,
            password: None,
            timeout: Duration::from_millis(1),
        };
        
        let git_manager = GitManager::new(config);
        let temp_dir = TempDir::new().unwrap();
        
        let result = git_manager
            .clone_repository(
                "https://github.com/large/repo.git",
                temp_dir.path(),
                None
            )
            .await;
            
        assert!(matches!(result, Err(GitError::Timeout(_))));
    }

    #[tokio::test]
    async fn test_clone_bare_success() {
        let config = GitConfig {
            ssh_key_path: None,
            username: None,
            password: None,
            timeout: Duration::from_secs(120),
        };
        
        let git_manager = GitManager::new(config);
        let temp_dir = TempDir::new().unwrap();
        
        let result = git_manager
            .clone_bare(
                "https://github.com/dtolnay/syn.git",
                temp_dir.path(),
            )
            .await;
            
        match &result {
            Ok(_) => println!("Bare clone successful"),
            Err(e) => println!("Bare clone failed: {:?}", e),
        }
        
        assert!(result.is_ok());
        
        // Verify it's a bare repository
        let repo = result.unwrap();
        assert!(repo.is_bare());
        
        // Check for git directory structure (no working directory)
        assert!(temp_dir.path().join("HEAD").exists());
        assert!(temp_dir.path().join("config").exists());
        assert!(temp_dir.path().join("refs").exists());
        assert!(!temp_dir.path().join(".git").exists()); // Bare repos don't have a .git directory
        
        // Verify the config
        let config = repo.config().unwrap();
        let bare_value = config.get_bool("core.bare").unwrap();
        assert!(bare_value);
    }
}

#[tokio::test]
async fn test_clone_public_repo_success() {
    let config = GitConfig {
        ssh_key_path: None,
        username: None,
        password: None,
        timeout: Duration::from_secs(120), // Increased timeout
    };
    
    let git_manager = GitManager::new(config);
    let temp_dir = TempDir::new().unwrap();
    
    let result = git_manager
        .clone_repository(
            "https://github.com/dtolnay/syn.git", // Smaller repo
            temp_dir.path(),
            None // Removed branch specification
        )
        .await;
        
    match &result {
        Ok(_) => println!("Clone successful"),
        Err(e) => println!("Clone failed: {:?}", e),
    }
    
    assert!(result.is_ok());
    assert!(temp_dir.path().join(".git").exists());
    assert!(temp_dir.path().join("Cargo.toml").exists());
}

#[tokio::test]
async fn test_branch_operations_success() {
    let config = GitConfig {
        ssh_key_path: None,
        username: None,
        password: None,
        timeout: Duration::from_secs(120),
    };
    
    let git_manager = GitManager::new(config);
    let temp_dir = TempDir::new().unwrap();
    
    // Clone with error checking
    let repo = match git_manager
        .clone_repository(
            "https://github.com/dtolnay/syn.git",
            temp_dir.path(),
            None
        )
        .await {
            Ok(r) => r,
            Err(e) => panic!("Clone failed: {:?}", e),
        };
        
    println!("Clone successful");
        
    // Test creating and checking out a new branch
    let branch_result = git_manager
        .checkout_branch(&repo, "test-branch", true)
        .await;
        
    match &branch_result {
        Ok(_) => println!("Branch creation successful"),
        Err(e) => println!("Branch creation failed: {:?}", e),
    }
    assert!(branch_result.is_ok());
    
    // Verify branch with error handling
    let head = repo.head().expect("Failed to get HEAD");
    let branch_name = head.shorthand().expect("Failed to get branch name");
    println!("Current branch: {}", branch_name);
    assert_eq!(branch_name, "test-branch");
    
    // Test fetch with error handling
    let fetch_result = git_manager
        .fetch_repository(&repo, "origin")
        .await;
        
    match &fetch_result {
        Ok(_) => println!("Fetch successful"),
        Err(e) => println!("Fetch failed: {:?}", e),
    }
    assert!(fetch_result.is_ok());
}