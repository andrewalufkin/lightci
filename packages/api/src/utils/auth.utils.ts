import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { authConfig } from '../config/auth.config';
import jwt from 'jsonwebtoken';

export interface JWTPayload {
  id: string;
  email: string;
  username?: string;
}

export interface APIKeyData {
  prefix: string;
  secret: string;
  hash: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, authConfig.bcryptSaltRounds);
}

export async function comparePasswords(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function generateJWT(user: { id: string; email: string; username?: string | null }): string {
  const payload: JWTPayload = {
    id: user.id,
    email: user.email,
    username: user.username || undefined,
  };

  return jwt.sign(payload, authConfig.jwtSecret, {
    expiresIn: authConfig.jwtExpiresIn,
  });
}

export function verifyJWT(token: string): JWTPayload {
  return jwt.verify(token, authConfig.jwtSecret) as JWTPayload;
}

export function generateAPIKey(): APIKeyData {
  // Generate prefix
  const prefix = crypto
    .randomBytes(Math.ceil(authConfig.apiKeyPrefixLength / 2))
    .toString('hex')
    .slice(0, authConfig.apiKeyPrefixLength);

  // Generate secret
  const secret = crypto
    .randomBytes(Math.ceil(authConfig.apiKeySecretLength / 2))
    .toString('hex')
    .slice(0, authConfig.apiKeySecretLength);

  // Generate hash
  const hash = crypto
    .createHash('sha256')
    .update(prefix + secret)
    .digest('hex');

  return {
    prefix,
    secret,
    hash,
  };
}

export function verifyAPIKey(prefix: string, secret: string, storedHash: string): boolean {
  const computedHash = crypto
    .createHash('sha256')
    .update(prefix + secret)
    .digest('hex');

  return computedHash === storedHash;
}

export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

export function extractAPIKey(authHeader?: string): { prefix: string; secret: string } | null {
  if (!authHeader || !authHeader.startsWith('ApiKey ')) {
    return null;
  }

  const apiKey = authHeader.slice(7);
  const [prefix, secret] = apiKey.split('.');

  if (!prefix || !secret) {
    return null;
  }

  return { prefix, secret };
} 