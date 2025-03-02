import { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../utils/errors';
import { userService } from '../services/user.service';
import jwt from 'jsonwebtoken'; // Try this import style

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log('[Debug] Auth middleware headers:', JSON.stringify(req.headers, null, 2));
    const authHeader = req.headers.authorization;
    console.log('[Debug] Authorization header:', authHeader);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[Debug] No valid authorization header found');
      throw new AuthenticationError('No token provided');
    }
    
    const token = authHeader.split(' ')[1];
    console.log('[Debug] Token extracted:', token ? 'Present' : 'Not found');
    console.log('[Debug] JWT object:', typeof jwt, Object.keys(jwt));
    
    // Verify the JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as { userId: string };
    
    // Get the user from the database
    const user = await userService.findById(decoded.userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }
    
    if (user.accountStatus !== 'active') {
      throw new AuthenticationError('Account is not active');
    }
    
    // Set the user on the request object
    req.user = user;
    next();
  } catch (error: any) {
    console.error('[Auth Error]', error);
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(new AuthenticationError('Invalid token'));
    } else {
      next(error);
    }
  }
};