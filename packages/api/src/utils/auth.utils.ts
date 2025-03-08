import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Constants for JWT configuration - avoid using authConfig
const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret';
const JWT_EXPIRES_IN = '24h';
const BCRYPT_SALT_ROUNDS = 10;
const API_KEY_PREFIX_LENGTH = 8;
const API_KEY_SECRET_LENGTH = 24;

export interface JWTPayload {
  userId: string;  // Use userId consistently 
  email: string;
  username?: string;
}

export interface APIKeyData {
  prefix: string;
  secret: string;
  hash: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export async function comparePasswords(password: string, hashedPassword: string): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

export function generateJWT(user: { id: string; email: string; username?: string | null }): string {
  console.log(`Generating JWT for user: ${user.id} with email: ${user.email}`);
  
  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    username: user.username || undefined,
  };
  
  // Log the payload and secret (partially)
  console.log(`JWT payload: ${JSON.stringify(payload)}`);
  console.log(`Using JWT secret: ${JWT_SECRET.substring(0, 5)}...`);
  
  try {
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    console.log(`Generated token: ${token.substring(0, 15)}...`);
    return token;
  } catch (error) {
    console.error('Error generating JWT:', error);
    throw error;
  }
}

export function verifyJWT(token: string): JWTPayload {
  console.log(`Verifying JWT: ${token ? token.substring(0, 10) + '...' : 'undefined'}`);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    console.log(`Decoded JWT payload: ${JSON.stringify(decoded)}`);
    return decoded;
  } catch (error) {
    console.error('Error verifying JWT:', error);
    throw error;
  }
}

export function generateAPIKey(): APIKeyData {
  // Generate prefix
  const prefix = crypto
    .randomBytes(Math.ceil(API_KEY_PREFIX_LENGTH / 2))
    .toString('hex')
    .slice(0, API_KEY_PREFIX_LENGTH);
  
  // Generate secret
  const secret = crypto
    .randomBytes(Math.ceil(API_KEY_SECRET_LENGTH / 2))
    .toString('hex')
    .slice(0, API_KEY_SECRET_LENGTH);
  
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