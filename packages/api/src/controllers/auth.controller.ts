import type { Request, Response } from 'express-serve-static-core';
import { hashPassword, comparePasswords, generateJWT, generateAPIKey } from '../utils/auth.utils';
import { registerSchema, loginSchema, createApiKeySchema, updateUserSchema } from '../utils/validation.schemas';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { prisma } from '../lib/prisma';

export async function register(req: Request, res: Response) {
  try {
    console.log('Starting registration process with body:', JSON.stringify(req.body, null, 2));
    
    console.log('Attempting to validate with Zod schema');
    const validatedData = registerSchema.parse(req.body);
    console.log('Zod validation passed successfully:', validatedData);

    // Check if user already exists
    console.log('Checking for existing user with email or username');
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
        username: validatedData.username,
        existingUserId: existingUser.id
      });
      return res.status(400).json({
        error: 'User with this email or username already exists',
      });
    }

    console.log('No existing user found, proceeding with user creation');

    // Create user
    console.log('Hashing password');
    const hashedPassword = await hashPassword(validatedData.password);
    console.log('Password hashed successfully');

    console.log('Creating user with data:', {
      email: validatedData.email,
      username: validatedData.username,
      fullName: validatedData.fullName
    });

    const user = await prisma.user.create({
      data: {
        email: validatedData.email,
        username: validatedData.username,
        passwordHash: hashedPassword,
        fullName: validatedData.fullName,
        accountStatus: 'active',
        accountTier: 'free',
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        accountStatus: true,
        accountTier: true,
      },
    });
    console.log('User created successfully:', { userId: user.id, email: user.email });

    try {
      // Create default notification preferences
      console.log('Creating default notification preferences for user:', user.id);
      await prisma.notificationPreference.create({
        data: {
          userId: user.id,
        },
      });
      console.log('Default notification preferences created successfully');
    } catch (prefError) {
      console.warn('Could not create notification preferences, continuing anyway:', prefError);
      // Don't fail registration if this fails
    }

    // Generate JWT
    console.log('Generating JWT token');
    const token = generateJWT(user);
    console.log('JWT token generated:', token ? `${token.substring(0, 15)}...` : 'undefined');

    // IMPORTANT: Use direct assignment to response.body to ensure structure is preserved
    const responseObj = {
      user,
      token
    };
    
    console.log('Returning structured response:', JSON.stringify(responseObj, null, 2));
    return res.status(201).json(responseObj);
  } catch (error) {
    console.error('Error in register:', error);
    if (error instanceof Error) {
      // Handle validation errors
      if (error.name === 'ZodError') {
        console.error('Zod validation error:', error.message);
        return res.status(400).json({
          error: 'Validation failed',
          details: error.message
        });
      }
      // Handle other known errors
      return res.status(400).json({
        error: error.message
      });
    }
    // Handle unknown errors
    res.status(500).json({
      error: 'An unexpected error occurred'
    });
  }
}

export async function login(req: Request, res: Response) {
  try {
    console.log('Login attempt:', JSON.stringify(req.body, null, 2));
    const validatedData = loginSchema.parse(req.body);

    // Debugging information
    console.log(`Looking for user with email: ${validatedData.email}`);
    
    const user = await prisma.user.findUnique({
      where: { email: validatedData.email },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        passwordHash: true,
        accountStatus: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        accountTier: true,
      }
    });

    if (!user) {
      console.log(`Login failed: User not found with email ${validatedData.email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log(`User found, verifying password for ${user.email}`);
    console.log(`Stored hash: ${user.passwordHash.substring(0, 10)}...`);
    console.log(`Input password: ${validatedData.password.substring(0, 3)}...`); // Log only first few chars for security
    
    const isPasswordValid = await comparePasswords(
      validatedData.password,
      user.passwordHash
    );

    console.log(`Password validation result: ${isPasswordValid}`);

    if (!isPasswordValid) {
      console.log(`Login failed: Invalid password for ${user.email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.accountStatus !== 'active') {
      console.log(`Login failed: Account not active for ${user.email}`);
      return res.status(403).json({ error: 'Account is not active' });
    }

    // Update last login timestamp
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    console.log(`Generating JWT for user ${user.id}`);
    const token = generateJWT(user);
    console.log(`Generated token: ${token ? token.substring(0, 15) + '...' : 'undefined'}`);
    console.log(`Login successful for ${user.email}`);

    // Return user details without sensitive data
    const { passwordHash, ...userWithoutPassword } = user;
    
    // Return with the expected structure
    const responseObj = {
      user: userWithoutPassword,
      token
    };
    
    console.log('Returning structured response:', JSON.stringify(responseObj, null, 2));
    return res.status(200).json(responseObj);
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

    console.log(`Creating API key for user ${req.user.id}`);
    const validatedData = createApiKeySchema.parse(req.body);
    const { prefix, secret, hash } = generateAPIKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user.id,
        keyName: validatedData.keyName || validatedData.name, // Support both name formats for tests
        keyPrefix: prefix,
        keyHash: hash,
        expiresAt: validatedData.expiresAt ? new Date(validatedData.expiresAt) : null,
        isActive: true,
      },
    });

    console.log(`API key created with ID ${apiKey.id}`);
    
    // Return format that matches test expectations
    return res.status(201).json({
      id: apiKey.id,
      keyName: apiKey.keyName,
      key: `${prefix}.${secret}`,
      isActive: apiKey.isActive,
      createdAt: apiKey.createdAt
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

    console.log(`Listing API keys for user ${req.user.id}`);
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

    console.log(`Found ${apiKeys.length} API keys`);
    
    // Return direct array to match test expectations
    return res.status(200).json(apiKeys);
  } catch (error) {
    console.error('List API keys error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteApiKey(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { keyId } = req.params;
    console.log(`Attempting to delete API key ${keyId} for user ${req.user.id}`);

    // First check if the key exists and belongs to the user
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: keyId },
    });

    if (!apiKey) {
      console.log(`API key ${keyId} not found`);
      return res.status(404).json({ error: 'API key not found' });
    }

    if (apiKey.userId !== req.user.id) {
      console.log(`API key ${keyId} belongs to user ${apiKey.userId}, not ${req.user.id}`);
      return res.status(403).json({ error: 'Not authorized to delete this API key' });
    }

    // Delete the key
    await prisma.apiKey.delete({
      where: { id: keyId },
    });

    console.log(`API key ${keyId} deleted successfully`);
    return res.status(204).send();
  } catch (error) {
    console.error('Delete API key error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Keep existing updateUser function
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

// Alias revokeApiKey to maintain backward compatibility 
export const revokeApiKey = deleteApiKey;