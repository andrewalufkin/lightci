import { Router } from 'express';
import {
  register,
  login,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateUser,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// Public routes
router.post('/register', register);
router.post('/login', login);

// Protected routes
router.use(authenticate);
router.post('/api-keys', createApiKey);
router.get('/api-keys', listApiKeys);
router.delete('/api-keys/:keyId', revokeApiKey);
router.patch('/profile', updateUser);

export default router; 