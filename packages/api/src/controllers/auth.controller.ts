import { Request, Response } from 'express';
import { hashPassword, comparePasswords, generateJWT, generateAPIKey } from '../utils/auth.utils';
import { registerSchema, loginSchema, createApiKeySchema, updateUserSchema } from '../utils/validation.schemas';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { prisma } from '../lib/prisma';

export async function register(req: Request, res: Response) {
  try {
    console.log('Starting registration process with body:', JSON.stringify(req.body, null, 2));
    
    const validatedData = registerSchema.parse(req.body);
    console.log('Validation passed successfully:', validatedData);

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: validatedData.email },
          ...(validatedData.username ? [{ username: validatedData.username }] : []),
        ],
      },
    });

    if (existingUser) {
      console.log('Registration failed: User already exists with email or username:', {
        email: validatedData.email,
        username: validatedData.username
      });
      return res.status(400).json({
        error: 'User with this email or username already exists',
      });
    }

    console.log('No existing user found, proceeding with user creation');

    // Create user
    const hashedPassword = await hashPassword(validatedData.password);
    console.log('Password hashed successfully');

    const user = await prisma.user.create({
      data: {
        email: validatedData.email,
        username: validatedData.username,
        passwordHash: hashedPassword,
        fullName: validatedData.fullName,
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        createdAt: true,
      },
    });
    console.log('User created successfully:', { userId: user.id, email: user.email });

    // Create default notification preferences
    await prisma.notificationPreference.create({
      data: {
        userId: user.id,
      },
    });
    console.log('Default notification preferences created for user:', user.id);

    // Generate JWT
    const token = generateJWT(user);
    console.log('JWT token generated successfully');

    return res.status(201).json({
      user,
      token,
    });
  } catch (error) {
    console.error('Registration error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause
    });
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid request data',
    });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const validatedData = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { email: validatedData.email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await comparePasswords(
      validatedData.password,
      user.passwordHash
    );

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // Update last login timestamp
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = generateJWT(user);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid request data',
    });
  }
}

export async function createApiKey(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const validatedData = createApiKeySchema.parse(req.body);
    const { prefix, secret, hash } = generateAPIKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user.id,
        keyName: validatedData.keyName,
        keyPrefix: prefix,
        keyHash: hash,
        expiresAt: validatedData.expiresAt ? new Date(validatedData.expiresAt) : null,
      },
      select: {
        id: true,
        keyName: true,
        keyPrefix: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    // Return the full API key only once
    return res.status(201).json({
      ...apiKey,
      apiKey: `${prefix}.${secret}`,
    });
  } catch (error) {
    console.error('API key creation error:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid request data',
    });
  }
}

export async function listApiKeys(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const apiKeys = await prisma.apiKey.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        keyName: true,
        keyPrefix: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ apiKeys });
  } catch (error) {
    console.error('List API keys error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function revokeApiKey(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { keyId } = req.params;

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        userId: req.user.id,
      },
    });

    if (!apiKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false },
    });

    return res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    console.error('Revoke API key error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateUser(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const validatedData = updateUserSchema.parse(req.body);

    // If updating password, verify current password
    if (validatedData.newPassword) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isPasswordValid = await comparePasswords(
        validatedData.currentPassword!,
        user.passwordHash
      );

      if (!isPasswordValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    // Prepare update data
    const updateData: any = {
      ...(validatedData.username && { username: validatedData.username }),
      ...(validatedData.fullName && { fullName: validatedData.fullName }),
      ...(validatedData.newPassword && {
        passwordHash: await hashPassword(validatedData.newPassword),
      }),
    };

    // Check username uniqueness if updating
    if (validatedData.username) {
      const existingUser = await prisma.user.findFirst({
        where: {
          username: validatedData.username,
          NOT: { id: req.user.id },
        },
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Username is already taken' });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        updatedAt: true,
      },
    });

    return res.json({ user: updatedUser });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid request data',
    });
  }
} 