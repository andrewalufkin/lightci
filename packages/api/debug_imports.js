// Save as debug-imports.js
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Function to check if a file exists
const fileExists = (path) => {
  try {
    fs.accessSync(path, fs.constants.F_OK);
    return true;
  } catch (err) {
    return false;
  }
};

// Try to trace the import chain
async function traceImports(startFile) {
  console.log(`Starting import trace from: ${startFile}`);
  
  // Check if the file exists
  if (!fileExists(startFile)) {
    console.error(`Error: File ${startFile} does not exist`);
    return;
  }
  
  // Read the file content
  const content = fs.readFileSync(startFile, 'utf8');
  
  // Find all imports
  const importRegex = /import\s+(?:{[^}]*}|\*\s+as\s+[^\s;]+|[^\s;,]+(?:\s*,\s*{[^}]*})?)\s+from\s+['"]([^'"]+)['"]/g;
  const imports = [];
  let match;
  
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  
  console.log(`Found ${imports.length} imports in ${startFile}:`);
  
  // Process each import
  for (const importPath of imports) {
    console.log(`- ${importPath}`);
    
    // Determine the actual file path
    let resolvedPath;
    
    // Handle different import types
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      // Relative import
      const basePath = dirname(startFile);
      resolvedPath = join(basePath, importPath);
      
      // Check for various extensions if not specified
      if (!importPath.includes('.')) {
        const extensions = ['.js', '.ts', '.mjs'];
        for (const ext of extensions) {
          if (fileExists(resolvedPath + ext)) {
            resolvedPath += ext;
            break;
          }
        }
      }
    } else if (!importPath.startsWith('@') && !importPath.includes('/')) {
      // Built-in or node_modules package
      console.log(`  (node module or built-in: ${importPath})`);
      continue;
    } else {
      // Try to resolve package imports (this is simplified)
      console.log(`  (package import: ${importPath} - skipping resolution)`);
      continue;
    }
    
    // Check if the resolved file exists
    if (fileExists(resolvedPath)) {
      console.log(`  ✓ Resolved to: ${resolvedPath}`);
    } else {
      console.log(`  ✗ Could not resolve: ${resolvedPath}`);
      
      // Try with different extensions
      const extensions = ['.js', '.ts', '.mjs', '/index.js', '/index.ts'];
      let found = false;
      
      for (const ext of extensions) {
        const testPath = resolvedPath.endsWith(ext) ? resolvedPath : resolvedPath + ext;
        if (fileExists(testPath)) {
          console.log(`  ✓ Found alternative: ${testPath}`);
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log(`  ! Import might cause runtime error: ${importPath}`);
      }
    }
  }
  
  console.log('\nImport trace complete.');
}

// Start tracing from server.ts
const serverPath = join(__dirname, 'src', 'server.ts');
traceImports(serverPath);