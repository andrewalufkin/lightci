const TOKEN_KEY = 'auth_token';

export function getStoredToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  console.log('[Debug] Getting token from storage:', token ? 'Present' : 'Not found');
  return token;
}

export function setStoredToken(token: string): void {
  console.log('[Debug] Storing token in localStorage:', token ? 'Present' : 'Not found');
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeStoredToken(): void {
  console.log('[Debug] Removing token from localStorage');
  localStorage.removeItem(TOKEN_KEY);
} 