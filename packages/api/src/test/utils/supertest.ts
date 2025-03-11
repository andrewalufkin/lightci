type SuperTestFn = (app: any) => any;

export async function createRequest(): Promise<SuperTestFn> {
  const mod = await import('supertest') as any;
  return mod.default;
} 