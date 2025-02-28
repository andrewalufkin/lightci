export interface User {
  id: string;
  email: string;
  username?: string;
  fullName?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData extends LoginCredentials {
  username?: string;
  fullName?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
} 