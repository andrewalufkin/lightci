export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^(\\.{1,2}/.*)\\.jsx?$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.json'
      },
    ],
  },
  setupFilesAfterEnv: ['./src/test/setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(supertest|methods|side-channel|call-bind|get-intrinsic|function-bind|has-symbols|has-proto|superagent)/.*)'
  ],
  maxWorkers: 1,
  testTimeout: 10000,
  detectOpenHandles: true,
  forceExit: true
}; 