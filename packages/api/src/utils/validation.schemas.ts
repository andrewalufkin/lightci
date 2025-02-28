import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  username: z.string().min(3).max(50).optional(),
  fullName: z.string().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const createApiKeySchema = z.object({
  keyName: z.string().min(1).max(100),
  expiresAt: z.string().datetime().optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(3).max(50).optional(),
  fullName: z.string().min(1).max(100).optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).max(100).optional(),
}).refine((data) => {
  // If newPassword is provided, currentPassword must also be provided
  if (data.newPassword && !data.currentPassword) {
    return false;
  }
  return true;
}, {
  message: "Current password is required when changing password",
  path: ["currentPassword"],
}); 