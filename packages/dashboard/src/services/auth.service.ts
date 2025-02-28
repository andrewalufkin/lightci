import axios from 'axios';
import type { LoginCredentials, RegisterData, AuthResponse, User } from '../lib/types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

const authApi = axios.create({
  baseURL: `${API_URL}/auth`,
  headers: {
    'Content-Type': 'application/json',
  },
});

export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  const response = await authApi.post<AuthResponse>('/login', credentials);
  return response.data;
}

export async function register(data: RegisterData): Promise<AuthResponse> {
  const response = await authApi.post<AuthResponse>('/register', data);
  return response.data;
}

export async function verifyToken(token: string): Promise<User> {
  const response = await authApi.get<User>('/verify', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
}

export async function updateUserProfile(token: string, data: Partial<User>): Promise<User> {
  const response = await authApi.put<User>('/user', data, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
} 