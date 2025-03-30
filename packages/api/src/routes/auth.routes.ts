import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express-serve-static-core';
import * as bcrypt from 'bcrypt';
import { AuthenticationError, ValidationError, AuthorizationError } from '../utils/errors.js';
import { generateJWT, verifyJWT } from '../utils/auth.utils.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { Router } from 'express';
import { validateSchema } from '../middleware/validation.js';
import * as authController from '../controllers/auth.controller.js';
import { prisma } from '../db.js';

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
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      throw new ValidationError('Email already exists');
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
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
    const user = await prisma.user.findUnique({
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

    const apiKey = await prisma.apiKey.create({
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
    const apiKeys = await prisma.apiKey.findMany({
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

    const apiKey = await prisma.apiKey.findUnique({
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

    await prisma.apiKey.delete({
      where: { id: keyId }
    });

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete API key' });
  }
};

// Delete user account
const deleteUser: RequestHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user.id;

    // Delete the user - this will cascade delete related records due to DB relationships:
    // - API keys (onDelete: Cascade)
    // - Organization memberships (onDelete: Cascade)
    // - User projects (onDelete: Cascade)
    // - Repository connections (onDelete: Cascade)
    // - Notification preferences (onDelete: Cascade)
    // - Usage records (onDelete: SetNull)
    // - Billing periods (onDelete: SetNull)
    await prisma.user.delete({
      where: { id: userId }
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user account' });
  }
};

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/api-keys', authenticate, authController.createApiKey);
router.get('/api-keys', authenticate, authController.listApiKeys);
router.delete('/api-keys/:keyId', authenticate, authController.deleteApiKey);
router.delete('/delete-account', authenticate, authController.deleteUser);

export default router; 