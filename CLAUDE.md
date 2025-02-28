# LightCI Development Guide

## Build Commands
- API: `cd packages/api && npm run build` (Compiles TypeScript to JS)
- Dashboard: `cd packages/dashboard && npm run build` (Builds React app)

## Development Commands
- API: `cd packages/api && npm run dev` (Runs with hot reload)
- Dashboard: `cd packages/dashboard && npm run dev` (Starts Vite dev server)

## Test Commands
- API: `cd packages/api && npm test` (Runs all tests)
- API single test: `cd packages/api && npx jest test/integration/artifacts.test.ts` (Run specific test)

## Lint Commands
- API: `cd packages/api && npm run lint` (ESLint for TypeScript)
- Dashboard: `cd packages/dashboard && npm run lint` (ESLint for TSX files)

## Code Style
- **Imports**: Use named imports, sort alphabetically
- **Exports**: Use named exports, prefer explicit exports
- **TypeScript**: Strict mode enabled, avoid `any`, use interfaces for objects
- **Formatting**: 2-space indent, semi-colons required
- **Error Handling**: Use custom error classes when possible, try/catch for async
- **Components**: Functional React components with hooks
- **Naming**: camelCase for variables/methods, PascalCase for classes/components/types
- **API Endpoints**: Route files use kebab-case, controllers use PascalCase