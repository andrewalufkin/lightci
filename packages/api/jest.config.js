export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
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
    'node_modules/(?!(cors|@types/cors|jsonwebtoken|supertest)/.*)'
  ],
  maxWorkers: 1,
  testTimeout: 10000,
  detectOpenHandles: true,
  forceExit: true
}; 