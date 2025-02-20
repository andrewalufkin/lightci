-- Create extension for UUID support
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create pipelines table
CREATE TABLE IF NOT EXISTS pipelines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    repository TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    description TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create pipeline steps table
CREATE TABLE IF NOT EXISTS pipeline_steps (
    id TEXT NOT NULL,
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    timeout_seconds BIGINT,
    environment JSONB NOT NULL DEFAULT '{}',
    dependencies TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (pipeline_id, id)
);

-- Create builds table
CREATE TABLE IF NOT EXISTS builds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    branch TEXT NOT NULL,
    commit TEXT NOT NULL,
    parameters JSONB NOT NULL DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create build logs table
CREATE TABLE IF NOT EXISTS build_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    build_id UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create artifacts table
CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    build_id UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create steps table
CREATE TABLE IF NOT EXISTS steps (
    id TEXT NOT NULL,
    build_id UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    environment JSONB NOT NULL DEFAULT '{}',
    dependencies JSONB NOT NULL DEFAULT '[]',
    timeout_seconds INTEGER,
    retries INTEGER,
    working_dir TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, build_id)
);

-- Create indexes for better query performance
CREATE INDEX idx_pipelines_name ON pipelines(name);
CREATE INDEX idx_pipelines_status ON pipelines(status);
CREATE INDEX idx_pipeline_steps_pipeline_id ON pipeline_steps(pipeline_id);
CREATE INDEX idx_builds_pipeline_id ON builds(pipeline_id);
CREATE INDEX idx_builds_status ON builds(status);
CREATE INDEX idx_build_logs_build_id ON build_logs(build_id);
CREATE INDEX idx_build_logs_step_id ON build_logs(step_id);
CREATE INDEX idx_artifacts_build_id ON artifacts(build_id);
CREATE INDEX idx_steps_build_id ON steps(build_id);

-- Add triggers to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_pipelines_updated_at
    BEFORE UPDATE ON pipelines
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_builds_updated_at
    BEFORE UPDATE ON builds
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_steps_updated_at
    BEFORE UPDATE ON steps
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 