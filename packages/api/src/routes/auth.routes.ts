import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express-serve-static-core';
import * as bcrypt from 'bcrypt';
import { testDb } from '../test/utils/testDb';
import { AuthenticationError, ValidationError, AuthorizationError } from '../utils/errors';
import { generateJWT, verifyJWT } from '../utils/auth.utils';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { authenticate } from '../middleware/auth.middleware';

interface RegisterBody {
  email: string;
  username: string;
  password: string;
  fullName: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface CreateApiKeyBody {
  name: string;
}

const router = express.Router();

// Register
const register: RequestHandler<{}, any, RegisterBody> = async (req, res, next) => {
  try {
    const { email, username, password, fullName } = req.body;

    // Validate password
    if (password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters long');
    }

    // Check if user exists
    const existingUser = await testDb.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      throw new ValidationError('Email already exists');
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await testDb.user.create({
      data: {
        email,
        username,
        passwordHash,
        fullName,
        accountStatus: 'active',
        accountTier: 'free'
      }
    });

    // Generate token
    const token = generateJWT(user);

    // Remove password hash from response and return the expected structure
    const { passwordHash: _, ...userWithoutPassword } = user;
    res.status(201).json({
      user: userWithoutPassword,
      token
    });
  } catch (error: any) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

// Login
const login: RequestHandler<{}, any, LoginBody> = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await testDb.user.findUnique({
      where: { email }
    });

    if (!user) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Generate token
    const token = generateJWT(user);

    // Remove password hash from response
    const { passwordHash: _, ...userWithoutPassword } = user;
    res.json({ token, user: userWithoutPassword });
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
    } else {
      next(error);
    }
  }
};

// Create API key
const createApiKey: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const authenticatedReq = req as AuthenticatedRequest;
  try {
    const { name } = req.body;
    const keyPrefix = 'test';
    const keyHash = await bcrypt.hash('test-api-key-' + Date.now(), 10);

    const apiKey = await testDb.apiKey.create({
      data: {
        userId: authenticatedReq.user.id,
        keyName: name,
        keyPrefix,
        keyHash,
        isActive: true
      }
    });

    res.status(201).json({
      ...apiKey,
      key: 'test-api-key-' + Date.now()
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create API key' });
  }
};

// List API keys
const listApiKeys: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const authenticatedReq = req as AuthenticatedRequest;
  try {
    const apiKeys = await testDb.apiKey.findMany({
      where: { userId: authenticatedReq.user.id }
    });

    const apiKeysWithoutHash = apiKeys.map(key => {
      const { keyHash: _, ...keyWithoutHash } = key;
      return keyWithoutHash;
    });

    res.json(apiKeysWithoutHash);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list API keys' });
  }
};

// Delete API key
const deleteApiKey: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const authenticatedReq = req as AuthenticatedRequest;
  try {
    const { keyId } = req.params;

    const apiKey = await testDb.apiKey.findUnique({
      where: { id: keyId }
    });

    if (!apiKey) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    if (apiKey.userId !== authenticatedReq.user.id) {
      res.status(403).json({ error: 'Not authorized to delete this API key' });
      return;
    }

    await testDb.apiKey.delete({
      where: { id: keyId }
    });

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete API key' });
  }
};

router.post('/register', register);
router.post('/login', login);
router.post('/api-keys', authenticate, createApiKey);
router.get('/api-keys', authenticate, listApiKeys);
router.delete('/api-keys/:keyId', authenticate, deleteApiKey);

export default router; 