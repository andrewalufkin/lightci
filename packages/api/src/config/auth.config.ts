export const authConfig = {
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-jwt-key',
  jwtExpiresIn: '24h',
  jwtRefreshExpiresIn: '7d',
  bcryptSaltRounds: 10,
  apiKeyPrefixLength: 8,
  apiKeySecretLength: 32,
} as const; 