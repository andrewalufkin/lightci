declare module 'supertest' {
  import type { Application } from 'express-serve-static-core';

  interface Response {
    status: number;
    body: any;
    headers: { [key: string]: string };
  }

  interface Test extends Promise<Response> {
    send(data: any): Test;
    set(field: string, val: string): Test;
    expect(status: number): Test;
    end(callback?: (err: Error, res: Response) => void): Promise<Response>;
    then<TResult1 = Response>(
      onfulfilled?: ((value: Response) => TResult1 | PromiseLike<TResult1>) | undefined | null,
      onrejected?: ((reason: any) => never | PromiseLike<never>) | undefined | null
    ): Promise<TResult1>;
  }

  interface SuperTest {
    (app: Application): SuperTest;
    get(url: string): Test;
    post(url: string): Test;
    put(url: string): Test;
    patch(url: string): Test;
    delete(url: string): Test;
  }

  const supertest: SuperTest;
  export = supertest;
} 